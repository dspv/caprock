# Changelog

All notable changes to Caprock. Format: [Keep a Changelog](https://keepachangelog.com/).
Versions map to the roadmap phases in `.ai/09-execution-plan.md`: **v0.1.0** = Observe,
**v0.2.0** = Control, **v0.3.0** = Orchestrate. **v0.4.x**/**v0.5.0** are post-Orchestrate
polish (plan-limit windows, orchestrator-lifecycle fixes, Homebrew formula, first-run UX).

## [Unreleased]

Changes waiting for the next release are one file each in `changes/unreleased/`,
assembled into a version section here by `scripts/changelog.py` when a release is
cut; `scripts/changelog.py preview` prints that section now. The format is in
`changes/README.md`.

## [0.128.1] - 2026-10-17

### Fixed

- **release:** 0.128.0 was tagged but never published: a phone Releases test
  read the "read N ago" line before the stats answer had drawn it, and failed
  the release run. The test now waits for the line; 0.128.1 carries 0.128.0.

## [0.128.0] - 2026-10-17

### Added

- **api:** AI;DR: `POST /v1/events/{id}/tldr` squeezes one agent answer into
  at most two short sentences, in the answer's own language, by a separate
  call to your own `claude` (Second Brain's headless runner, Haiku, no
  session written), only when you tap it. Never typed into the session. The
  result is kept, so a second tap makes no call; an answer under 280
  characters is its own TL;DR. A paired controller phone may use it
  (ADR-072).
- **ui:** Halloween pumpkins for Claude's portrait: eight of them (a
  jack-o'-lantern, a witch, a vampire, a ghost, a black cat, a mummy, a
  monster and a lantern) on a new *Pumpkins* tab of the face menu, and
  *A pumpkin per session* in Settings → Appearance. Nobody's current face
  changes.
  Through October the quiet *try a duck?* line beside an idle portrait
  says *try a pumpkin?* instead and opens the pumpkins.
- **support:** Report a bug, from the phone bar's + menu and ⌘K *Report a
  bug…*: type or dictate what happened, attach up to three screenshots (made
  small on the device), add an email if you want a reply, and press Send to
  support. It goes privately to Caprock support at caprock.dev, never to
  GitHub, and only on that click; the sheet lists exactly what is sent — your
  text, the screenshots, the email if given, the Caprock version and the OS
  (ADR-073).

### Changed

- **phone:** the chat's bottom bar is one row: a speaker switch that reads
  new answers aloud (on by default, remembered per device), a + menu with
  Photo, New chat and Report a bug, a one-line field that Enter sends, and a
  round hold-to-talk microphone — hold to speak and release to send, tap to
  start and tap again to send, slide off to cancel. The latest answer carries
  AI;DR (a two-line summary from your machine), Read aloud, Continue and
  Stop. Esc, Tab, the arrows, Enter, Ctrl+C and the dictation language moved
  to the session's ··· menu. The desktop chat is unchanged.

## [0.127.0] - 2026-10-16

### Added

- **ui:** Halloween pumpkins for Claude's portrait: eight of them (a
  jack-o'-lantern, a witch, a vampire, a ghost, a black cat, a mummy, a
  monster and a lantern) on a new *Pumpkins* tab of the face menu, and
  *A pumpkin per session* in Settings → Appearance. Nobody's current face
  changes.
  Through October the quiet *try a duck?* line beside an idle portrait
  says *try a pumpkin?* instead and opens the pumpkins.
- **ui:** the Pipeline's *Next release* panel says where the release itself
  is: the next version's bump and why (*minor · a feature since …*,
  *patch · fixes only*), then its stages as the pull request rows' pills —
  merged → release PR → CI → tag → builds → published → site — the current
  one filled, done ones ticked, and any stage Caprock cannot read (the
  site's deploy) left neutral with a *?* rather than guessed. A tag already
  pushed and still building shows above as *releasing*, its builds counted
  as files on the release against the release before it. Under the rows,
  one line for the last release: when, how many files, and a link.
- **github:** the releases the board lists carry their uploaded file count
  (`assets`), from the same request.

### Changed

- **phone:** a session or chat can be ended from wherever the phone lists it,
  not only from inside it (owner: trial chats could not be ended). Each live
  row Caprock started — the home's Chats and Continue, All sessions, the Chats
  screen — has *End session…* in its ⋯ (a swipe left opens it too), one
  confirm, then the polite stop that keeps the conversation; the row then
  reads *ended*, and an ended chat stays in Chats to be continued. A chat's
  own ⋯ has *End this chat…* first. Where End is not offered the row and the
  session's sheet say why in one line: a session started in your own terminal
  is never stopped by Caprock, and a phone that can only watch is told where
  to allow control (Settings → Use on your phone → Let it control sessions).

### Fixed

- **ui:** the version panel can check again right after a check. When you are
  on the latest version and the last check is recent, the "Checked 4m ago"
  line carries a *Check again* link beside the What's new button.

## [0.126.0] - 2026-10-16

### Added

- **chats:** Chats are their own kind of session. Start one in one tap on the
  phone home, the new Chats screen, or ⌥⌘N in the app, on the model you used
  last (a compact model chip changes it). Chats are listed apart from your
  projects, newest first, with search, rename, archive and delete, and a count;
  a chat reads as a conversation, never a terminal, and can be continued after
  it ends. The files a chat writes open in a viewer — Markdown rendered, HTML
  sandboxed with no scripts, PDF in the browser's viewer, images — and can be
  downloaded, on a phone too. A paired phone that may control can now start,
  continue, archive and delete chats. *Quick chat with…* keeps the model
  chooser (ADR-071).

### Changed

- **app:** ⌘W closes the tab in front, not the window. The macOS menu's
  Close Window held ⌘W, so the key hid the whole window; File → Close Tab
  holds it now and closes the tab as its × does, asking first about a
  running agent or shell. With the Dashboard in front it does nothing;
  Window → Close Window (no key), the red button, ⌘H and ⌘M still put the
  window away, and in the Mail window ⌘W still closes it. Windows and Linux
  keep Ctrl+Shift+W, since Ctrl+W is the shell's delete-word.
- **app:** the Premium dialog's *Also in Premium* chips are bigger, so the row is seen at first glance.
- **app:** the version panel says *You're on the latest version* in a sentence and shows one button — what's new right after a check, Check now otherwise.
- **app:** a *Waiting for you* row on Home is one big way back into that
  session: a click anywhere on it, Enter, or its amber *Open terminal →* opens
  the session's tab in the desktop app (opening one if needed), or its
  terminal in a browser. *what did it ask?* still opens the answer in place,
  and the row now names the session after the project, so two waiting rows in
  one project say which is which.

## [0.125.0] - 2026-10-16

### Added

- **docs:** `docs/install-agent.md` says what the install does, where it lives and how to remove it; the agent install prompt is now five lines, runs the same script as the site, and leaves Claude Code's settings to the app.
- **ci:** `make e2e` drives the app's golden paths in Playwright's own
  headless shell against a sandboxed daemon (temp home and data directory, a
  free port, the fake `claude`): the workspace loads with no console errors,
  sessions open as tabs with a sidebar row in Tree and Flat, typing, paste and
  a native file drop reach the terminal, and the palette, Settings, Second
  Brain, Pipeline and the share dialog open. `make pr-check` runs it when
  `ui/` or `internal/api/` changed, and CI runs it on Ubuntu. The app's own
  tests now check that a drop is heard as both the window's and the
  webview's event, through one handler (the 0.123.0 bug).
- **mail:** AI sorts the inbox. With AI on, Mail labels your newest 200
  conversations, then new mail as it arrives, as Important, Updates,
  Newsletters or Spam, with a one-line summary in place of the snippet and
  a *Reply* mark on mail that waits on your answer. Filters along the top
  of the inbox — `1` All (everything but spam), `2` Important, `3` Updates,
  `4` Newsletters, `5` Spam with its count. Nothing moves on the server by
  itself: `!` sends a conversation to Junk, `n` says it is not spam, and
  Mail remembers that for the sender too. While it works the list says
  *Sorting 37 conversations…*; with AI off one line offers *Let AI sort
  your inbox — Turn on* and says where the text goes. Sorting uses the
  provider you picked in Mail's settings, a batch of conversations per
  call, in the background. The sample inbox shows the labels without any
  AI call.
- **mail:** Who does the AI work is named wherever it acts — under the
  inbox filters, under every summary and on the composer's AI bar — with
  *change* opening Settings at the AI section, and the reader shows a
  conversation's stored one-liner at once. A new *Language* setting
  (same as the email, English, Russian, Spanish, German) sets what
  summaries are written in; a drafted reply keeps the language of the mail
  it answers.
- **mail:** junk stays out of the Inbox, even when your mail provider
  leaves it there (owner request, translated: "there's a lot of spam in my
  inbox — every mail client filters this"). Caprock's own filter runs on the
  machine, with no AI and nothing sent anywhere, and is on from the start. It
  reads what the receiving server wrote into each message — SPF, DKIM and
  DMARC results and the server's own spam verdict — plus a few cheap checks
  (a brand name on an unrelated domain, replies sent to a free mail address,
  URL shorteners, image-only mail), and a small learning classifier taught by
  your Spam folder and by every *Spam* (`!`) and *Not spam* (`n`, new) you
  press. Anyone you have written to, or said *Not spam* for, is never junk.
  Hidden mail is listed under *Caprock thinks these are junk* in Spam
  (`g !`), whose count the sidebar shows, and the reader says why; nothing is
  moved or deleted on the server unless you press Spam yourself.
- **mail:** with AI sorting on, Spam is one list and one count whoever
  found it: the inbox's Spam filter (`5`) and the Spam folder view show the
  junk filter's catch first, then the AI's, each with a single *Spam* label,
  and `n` clears both at once — the filter learns, the AI's label is taken
  back, and the sender is never spam again. Mail the filter caught is never
  sent to the AI.
- **mail:** Mail from the keyboard, with the key on every action. Each
  button shows its key as a small chip — `e` archive, `#` delete, `v` move
  (a numbered folder list), `s` star, `u` unread, `i` summarise, `r`/`a`/`f`
  reply, reply all, forward, `c` compose — the folders show `g i`, `g u`,
  `g s` and the rest, `/` search, `,` settings, `g r` check mail, and `?`
  lists every shortcut. `t` opens the theme list: `j`/`k` show each palette
  at once, Enter keeps it, Esc goes back, a digit picks — Sunlight outside,
  Dark Pastel at night. *Summarise* is there even with AI off: the first
  press says which provider would answer and where the mail goes, and
  *Turn on and summarise* switches it on. In the composer ⌘↩ sends and ⌘J
  drafts the reply with AI.

### Changed

- **app:** feedback is one box: type what's wrong, drop or paste a
  screenshot anywhere on it, and press Send (⌘↩, Ctrl+Enter off macOS). The
  first line becomes the issue's title. Bug / Idea / Question, the
  diagnostics, *Choose image…* and *Capture window* are under *Details*;
  nothing else is required. What you typed is kept until it is sent, so Esc
  loses nothing. Send still opens a prefilled GitHub issue in your browser
  for you to submit; Caprock sends nothing itself.
- **pipeline:** The *Next release* plan uses its width. Its bar grows with
  the panel, one taller segment per step (agent, PR, CI, merged, released),
  each named on hover, and the step under way breathes softly. Beside the
  stage word, as the width allows, each row says what it waits for now
  (*CI on Windows · 6m*, *needs a rebase*, *fix: go (windows-latest)*,
  *a release*), the agent cost recorded on it at API list price (*—* where
  no session was), a dot per OS its checks ran on, how long its CI took
  against the usual (*14m +27%*, *6m / ~11m* while running), and how long
  ago it was opened. In a narrow panel these columns drop first, and the plan never
  scrolls sideways. On the phone each row also says what it waits for.
- **brain:** Second Brain leads with what it is for. One status line on top
  (*Up to date · 278 memories · 137 new today · 91 topics · $0.15 in 24 h*,
  or the stage and N of M over the progress bar while it builds) replaces
  the three step blocks and six tiles, with the rest under *Details*. The
  middle is **What your next session gets** — pick a repository and see the
  up-to-five memories a new session there is handed, in order, and whether
  one opening now would get them — then **Recent memories** with search, a
  project and a span. The graph is a small card on the side; a click opens
  it in a near-full-screen dialog to zoom, pan and explore (Esc, × or the
  backdrop close it). The *Graph* | *List* switch is gone. New read-only
  `GET /v1/brain/handoff?project=` names the memories with the same pick
  the handoff makes.
- **app:** every dashboard page says where you are and how to get back. Off
  Home the header reads *caprock / Pipeline* (the browser tab too:
  *Pipeline · caprock*), one item is highlighted — Settings included — and a
  *← Home* button returns to Home in the same tab. In the app the Pipeline and
  Mail tabs carry *← Dashboard*, which brings the Dashboard tab back. Links
  that leave Caprock are marked ↗ and say *Opens in a new tab* (or *Opens in
  your browser* in the app); links that stay inside use → instead. The
  version dialog's link to turn release checks on now opens Settings rather
  than falling through to Home.
- **app:** Mail opens in a window of its own, not as a tab inside Caprock's
  window with the sidebar beside it. In the desktop app the sidebar's *Mail*,
  ⇧⌘M and the palette's *Open Mail* launch or bring forward the Caprock Mail
  preview when it is installed (macOS, in Applications); without it they open
  a second Caprock window, *Caprock Mail*, with Mail alone, brought to the
  front when it is already open. In a browser the Mail tab stays, under a
  banner, *Mail works best in its own window*, whose button — or ⇧⌘M on the
  Mail tab — opens Mail alone in a browser window.
- **app:** the Premium dialog shows the whole plan, not only the feature you
  clicked. Its header counts the plan and states the yearly price ("Premium ·
  8 features · $30 a year"), and under the feature one row of chips names the
  other seven; a chip shows that feature in place, and the ones added in the
  last 30 days are marked New.

### Fixed

- **app:** the right panel's CI block lists only what is in flight: open pull
  requests, and the ones merged since the latest release. Released and
  closed ones are gone, so a repository that publishes no releases (a site
  that pushes straight to master) no longer fills the block with every merge.
  With nothing in flight it says so in one line, with the last release and how
  long ago it was, over the three newest merges. Ring and By OS are never
  blank: without the session deck's own PR they draw the newest pull request
  in flight, read its checks themselves, and say "Nothing in flight" when
  nothing is.
- **ui:** a freshly opened window no longer logs a 404 for
  `/v1/projects/dir:…/cleanup`: the finished-copies line waits for the
  daemon's own project list instead of asking about a project the window
  derived while that list was loading. Found by `make e2e`.
- **app:** a new release shows within minutes. The release check is due
  every 15 minutes (it was hourly, so a release could sit unannounced for
  most of an hour), and when you come back to the window Caprock checks
  again if the last check is ten minutes old. Never more than one check per
  ten minutes unless you ask; still one conditional request to GitHub, and
  only while Settings → Updates allows it.
- **app:** the answer to a check is at the bottom right, beside the
  version, where you look for it: *Checking for updates…*, *Caprock is up
  to date* for a few seconds, *Couldn't check for updates* with **Retry**,
  or **Update to vX — Restart** as an amber pill. The banner at the top
  centre is gone from the app.

## [0.124.1] - 2026-10-16

### Changed

- **brain:** the wheel scrolls the page past the Second Brain graph instead of
  zooming it. Click the graph (or press Enter on it) to zoom and move it; an
  accent ring shows it is in hand, and Escape, a click outside or the mouse
  leaving lets it go. A click on a dot still opens it, and Fit works either way.

### Removed

- **app:** the Page tab is gone for now: with it the app crashed on macOS 27 and drops went missing. ⌘-click opens a link in your browser again (ADR-070, withdrawn).

### Fixed

- **phone:** quick replies under a session's chat take the page's own surface
  in a light theme (Light, Light Cold, Book and the rest) instead of drawing as
  dark pills; under an agent's terminal in the app they still sit on the
  terminal's ground.
- **app:** a file dropped beside a terminal — on the tab strip, a margin, the composer — goes to the terminal you used last instead of vanishing, and a drop with nowhere to go says so.

## [0.124.0] - 2026-10-16

### Changed

- **app:** the sidebar's Today card has three states, kept per viewer: the
  full card, one line (`$33.79 · 11 running · 5h 6% · 7d 74%`, plus what
  waits when anything does) by its chevron, or hidden by the × that shows on
  hover. Right-click offers Full card, One line and Hide; Settings →
  Appearance → *Today card in the sidebar* brings it back. Its Share button
  is gone: sharing stays in ⌘K and on Pipeline.

### Fixed

- **app:** every tab in the strip has a row in the sidebar, in Projects and
  in Tabs view. A project or session hidden by hand and then opened again
  (from More…, a link or a restored workspace) had a ⌘N tab and no row; it
  is now listed while its tab is open, and goes back behind More… when the
  last tab closes. Hiding a project from its menu also closes its tabs.
- **ci:** a computer that removed this one is said so at once: a second check
  of a machine, asked while one is in flight, waits for its answer instead of
  returning the state from before it, so the proxy answers 403 "revoked" right
  after a revoke rather than passing the other computer's 401 on (the
  two-daemon smoke test's Windows failure). In New project from a template, a
  card clicked before the sheet had settled is the one chosen; the first card
  is chosen by default without an effect that could overwrite the click.
  `make pr-check` runs the whole UI suite when `ui/` changed, not only the
  changed test files.

## [0.123.1] - 2026-10-16

### Fixed

- **app:** a file dragged onto a terminal (a screenshot's thumbnail, a Finder file) types its path again; 0.123.0 heard no drop at all.

## [0.123.0] - 2026-10-16

### Added

- **app:** a Page tab — open a web page inside Caprock, apart from your
  agents. ⌘-click (Ctrl-click on Windows and Linux) a web link in an agent's
  terminal or chat, pick *Open a page…* in ⌘K or the + menu, or type an
  address such as `localhost:5173` into ⌘K. The page gets its own tab after
  every agent's, with a globe, back, forward, reload, an address field, copy
  and *Open in browser*; it takes no ⌘1–⌘9 and no sidebar row. In the
  desktop app it is the system's own web view with no access to Caprock and
  no cookies shared with it, loaded only when you ask, and freed after five
  minutes behind other tabs; in a browser, only a page on this machine opens
  in a tab and any other goes to the browser.

### Fixed

- **remote:** revoking a device closes its terminal opened through the relay
  at once, with "this device was removed". A keystroke arriving as the socket
  closed used to drop the stream without telling the other computer, and its
  terminal stayed open. After one failed write the stream now drops what is
  typed next at once instead of writing it into the closing socket.
- **daemon:** stopping the daemon waits for its background work (history
  backfills, pruning, Second Brain's loop, the projects list and any clone
  still running) before the database closes, instead of leaving it to read a
  closed database; a clone in progress is stopped rather than left writing.
- **ci:** `make pr-check`, the step before a pull request: the changed Go
  packages with `-race`, their changed tests three times, a Windows vet and
  test build, and the changed dashboard tests. Four flaky tests were fixed at
  the root.

## [0.122.0] - 2026-10-16

### Added

- **pipeline:** what an hour of agent work costs, and how big the agent
  team is. Two new figures end the Flow row for the picked repository.
  **Cost / agent-hour** is the last 24 hours' spend per active agent-hour,
  at API list price (an estimate). An agent-hour is the burn rate's own
  rule: one session's clock hour with five or more priced calls. The
  figure carries a 15-day line, *▲ 35% vs 14-day avg*, and tokens per hour
  and in all. **Agent team** shows the main sessions and subagents at work
  in the last ten minutes and today's peak. Its line counts distinct agents
  a day, captioned with the 14-day average and peak, with each day split
  by agent kind on hover. Pressed, it opens a 31-day stacked bar chart,
  like a contributors graph. Both are read from this machine's events by
  the new `GET /v1/pipeline/agents`. With too little history they say
  *not enough history*.
- **pipeline:** share the figures. A Share pill in the Pipeline's head draws
  the eight Flow figures, each with its 14-day line, as a 2x card in the
  screen's theme, with the dates and caprock.dev. Save it, copy it, post it
  to X or LinkedIn with words you can edit (the card goes on the clipboard
  to paste in), or send it to Telegram: To me through your own paired bot
  (`POST /v1/telegram/photo`, only on that click), or to someone else
  through Telegram's share link. The card and the words are anonymous by
  default ("a GitHub repo", aggregates only, no titles, branches, authors
  or paths); Show repo name is an opt-in for that one share and is never
  remembered. The dashboard's share sheet gained the same Post and
  Telegram actions.
- **machines:** one of your computers can work on another's sessions
  (ADR-067). On the computer to be reached, `caprock pair --computer`
  prints a link (turning access from anywhere on if it is off); on the
  other, `caprock machines add '<link>'` pairs with it through that
  computer's own relay, end to end encrypted. Nothing is let in until the
  first computer's owner allows it by name: a card on its screen, the
  prompt in the terminal that printed the link, or `caprock machines allow
  <name>` over SSH. An allowed computer can start agents in any folder, open
  shells and run tasks there, but never change that computer's settings,
  pairing, updates or the doctor's stop. `caprock machines revoke <name>`
  or Remove ends it at once, open terminals included, and `caprock machines
  forget <name>` on the other side drops it from both. On Linux both
  `caprock service install` and `caprock pair --computer` say when
  `loginctl enable-linger` is needed to stay reachable with nobody logged
  in.
- **phone:** the phone home shows your releases: per repository, the next
  version and a row per piece of work with its ten-block progress bar and
  stage word, the release plan the Pipeline and Work → Release draw. A row
  opens its pull request on GitHub; a chip switches repository. It reads on
  opening, on release news, on *Refresh* and on a pull at the top of the
  home-screen app — never on a timer. A paired phone may now read
  `GET /v1/sessions/{id}/ci/stats` (read-only), which the bars come from.
- **phone:** end the session you are in from its bar: a red *End* on a
  session Caprock started, one confirm sheet (*The conversation is saved
  and can be continued.*), then the polite stop: Claude Code is asked to
  exit and write its transcript out, and is killed only if it is still
  running a few seconds later, so the session can be resumed. Sessions started outside Caprock, and phones that may only
  read, see no End.
- **phone:** the session's bar stays at the top while Timeline, Changes or
  Answers scroll, over the notch, so the way back is always one tap away.
- **brain:** see Second Brain build. A header strip on its screen says the
  state (*Building · reading session 12 of 48* over a progress bar, *Up to
  date · last built 14:02*, *Paused*, *Stopped*, *Waiting* for today's
  limit), which step a read is at (find sessions, Claude extracts, link into
  the graph) with the session being read, what it gives (how many new
  sessions were handed its memories) and counted figures: memories, new
  today, topics, links, tokens and cost at API list price in the last 24
  hours. The folded sidebar card reads *Building · 12 of 48* over a thin
  bar while it builds. `GET /v1/brain/status` carries `stage`, the read's
  `phase` and these counts; migration 0058 records the memories each new
  session is handed.
- **hermes:** Caprock sees Hermes Agent. Its sessions, prompts, replies, tool
  calls, tokens and cost are read from Hermes's own database, read-only, and
  shown beside every other agent, with a `hermes` filter and Hermes's own
  glyph. Cost is Hermes's figure, never re-priced, and the Cost screen says
  which part the provider reported and which is Hermes's estimate. Cron jobs
  and gateway chats (Telegram, Slack…) are shown apart as background runs, by
  source. Delegated subagents sit inside the session that delegated them,
  counted once. **New agent → Hermes** starts `hermes chat` in a terminal tab
  and links it to its Hermes record; with no model set, `hermes model` is
  offered as your own step. See `docs/hermes.md`.
- **app:** Markdown reads comfortably in a file tab, and goes to another agent
  in one click. The document sits at a reading measure with a larger heading
  scale; code blocks have a Copy button, wide tables scroll on their own,
  task lists show real check boxes, headings take anchors that in-page links
  jump to, and a relative picture is read from the project through the
  daemon (one on the web stays its alt text, so nothing is fetched from
  outside the machine). Contents sit beside a long document on a wide window
  and in a dropdown on a narrow one, with a thin reading-progress line. The
  tab's header has a quiet toolbar: *Copy path*, *Copy for an agent*
  (`@/absolute/path`, which Claude Code, Codex and the others read as a file
  reference), *Copy Markdown*, *Download*, and *Send to a session*, which
  types that reference into a running agent Caprock started without sending
  it, then brings that agent forward for you to add your words. A `.md` path
  an agent prints in its chat or terminal now opens the file in a tab
  (⌘-click in the terminal, Ctrl+click elsewhere), and *Open file…* lists
  Markdown files first. Every "link" is a path on this machine; nothing is
  uploaded.

### Changed

- **ci:** a pull request no longer carries the built dashboard
  (`internal/api/dist`). Every two PRs that touched `ui/` used to conflict
  there, because the bundle's file names are content hashes; now a PR that
  changes it fails CI's *no dist in the PR* check (and `make check`) with
  the command that drops it (`make dist-reset`), and a new `dist` workflow
  rebuilds and commits it on `master` after each merge that touches `ui/`.
  `go install …@latest` still embeds the tag's dashboard: release `verify`
  and `make release-ready` check that the tagged commit's copy is its own
  `ui/` built, so a release is tagged after that rebuild lands (ADR-068).
- **brain:** the Second Brain graph looks like a knowledge graph: one round
  disc of small dots that fills the panel, with topics and projects as little
  bursts of their memories. Dots are in the text colour (dark in a light
  theme) with a faint tint for topics, edges are hairlines, and the one accent
  marks the node you hover or open. No names at rest: the hubs' names fade in
  as you zoom, then every memory's, and hovering names a node and its
  neighbours while the rest fades. It settles before it is shown and then
  stays still (no frames at rest); drag a dot and its neighbours follow,
  scroll or pinch to zoom, and *Fit* brings the whole disc back. The
  sidebar's turning brain uses the same small dots and hairlines.
- **pipeline:** the *In flight*, *Needs a fix* and *Ready* counts open the
  pull requests behind them. Hovering or focusing one lists up to five with
  why each is there (*CI red*, *Conflict*, *Changes requested*), and *Needs
  a fix* says how many the page saw fixed in the last 24 hours. A click
  filters the list to them across the whole repository, even from *This
  session*, with a *Needs a fix · 4 ×* chip to clear it, and scrolls to
  the list. A red pull request's CI pill names the failed checks on hover.
- **app:** "Caprock on this computer" (the popover behind *caprock 1.6 GB ·
  1.8 GB* in the status bar) says what is wrong in one line — *All good —
  Caprock uses 1.6 GB*, or *Caprock is using more than it should* with one
  **Clean up (frees ~X MB)**. Below it, one row per kind of problem in plain
  words, each with a line of why, its size and a small Stop: *Test copies of
  Caprock* (left by agent work in temporary folders and worktrees, not your
  app), *Leftover helpers* (servers finished agent sessions left running),
  *Disk reads* (normal or more than usual). Pids, paths and the long
  explanations moved under each row's *Details*; the memory and disk
  breakdown is behind *What the 1.6 GB is spent on*. Every stop shows the
  list first, one checkbox per process with the safe ones ticked, and stops
  nothing until you click *Stop*. The *Advanced* checkbox is gone.

### Fixed

- **remote:** turning access from anywhere on in the first moments after
  Caprock started could leave it connected but reporting itself off, so the
  pairing link came back empty until the next restart. The settings are now
  read once, under the same lock as the switch.
- **remote:** a request cancelled by the phone or another computer is no
  longer ended as if its answer were complete, so a cut-short answer is
  never read as whole.
- **app:** only the tab you are in looks selected (a user could not tell
  where she was: the tabs waiting on her wore the same accent bar along
  their top as the tab in front, so four tabs looked selected). The tab in
  front alone has the 3px accent edge, the panel's fill and a bold title,
  and room for about 16 characters of it — it read *ca…*; there its
  project's name gives way first. A tab waiting on you shows an amber dot
  before its title, pulsing slowly; one looping or failed a red dot. Never
  a bar.
- **app:** closing an agent's tab is one decision at most, and always says
  the conversation is saved. An idle agent Caprock started ends with its
  tab, no question, and a toast says *Closed. The conversation is saved —
  reopen it from History or the sidebar.* One still working or waiting gets
  one sentence, **Close tab** (it keeps working in the background) and a
  quiet *Stop it instead*; no checkbox. Settings → Closing a tab still
  makes it always keep or always stop. Ending now asks the agent to stop
  (SIGTERM, then a kill after 5 seconds) instead of killing it at once, so
  Claude Code writes its transcript out and the session can be continued
  with --resume; the agent-signal endpoint takes `end` for this.
- **tests:** the template sheet test reads the plan once the parent folder has loaded, so it no longer fails on a slow runner.
- **ui:** Live Pulse puts the hour's cost in one right-aligned column: every
  row's chart, money and agents tracks are fixed widths, so `$28.98` and
  `$0.03` no longer sit at different places depending on the model name
  beside them.
- **ui:** Telegram is always a choice on both share sheets (Share your
  figures and the Pipeline's), in a row right under
  Share… / Copy / Save. **Send to my Telegram** sends the card through your
  own bot to your own chat (or reads **Set up Telegram** until one is
  connected); **Send to someone in Telegram** copies the card and opens
  Telegram's chat picker — the Telegram app itself in the desktop app when
  it is installed, else t.me — saying "Image copied — paste it in the chat".

## [0.121.0] - 2026-10-15

### Added

- **brain:** Second Brain says where it is kept — in its Settings and under
  *Details* in How it works: the real path of `caprock.db` as the daemon
  resolved it (with *Copy path*), the tables `brain_nodes`, `brain_edges`
  and `brain_runs`, and that the session text goes to Anthropic through
  your own Claude to be read while nothing goes to Caprock.
  `GET /v1/brain/status` carries the path as `db_path`.
- **remote:** the groundwork for reaching your other computers through the
  relay (ADR-067). A Caprock daemon can now be a client of another
  machine's daemon over the same end-to-end encrypted channel a phone uses,
  pair with it by its link and keep the token in `machines.json` (0600),
  opening the channel only while something needs it. Nothing to see yet:
  the routes, the target's computer pairing and the app follow.

### Changed

- **app:** the sidebar's session rows are bigger and easy to read (a user
  could not read them, nor tell which tab she was in). Rows are 38px with
  the title at 14px; each says its state as a dot and a word — green and
  breathing while it works, amber while it waits, faint when idle — and a
  tab's key is the footer's readable chip. The flat list no longer draws
  the project's name on each row; the tooltip and screen readers still say
  it. Only the tab in front looks selected now (an accent tint, a 3px
  accent edge and a bold title): a row waiting on you is marked by its
  amber dot and word, no longer by a fill and edge of its own, and the
  project in front lost its edge. The Today card folds to one line by its
  chevron and can be hidden from its right-click menu; Settings →
  Appearance shows it again, and while it is hidden the list's heading
  counts what waits on you.
- **app:** the sidebar's Second Brain card is quiet by default: folded to one
  muted row, *Second Brain · Idle · 140 memories* or *Indexing 3 sessions…*,
  whose small glyph pulses slowly only while a read runs. It lifts a pixel on
  hover, a click opens Second Brain, and the chevron unfolds a calmer orb
  (smaller, slower, fainter, fewer sparks). A fold you saved is kept. The
  card now sits under the list and above the footer instead of at the end
  of the list's scroll, so its status line is never cut off by the footer;
  when room is short the orb shrinks (and in a window under 640px tall is
  not drawn). The orb's sparks also follow the sessions working now.
- **app:** the right panel's CI pull-request bars say what their stages are:
  one faint line, *open · CI · merged · released*, over the bars' columns,
  and each segment's tooltip names its step and state (done, running,
  failed, waiting) with the landing-queue label on the step a PR is on. The
  rows are as tall as before.

### Fixed

- **app:** on macOS the first click on a Caprock window that is not in front
  reaches the page: a tab's × in the title-bar strip closes the tab at once
  instead of the first click only bringing the window forward. Dragging the
  window by its title bar works as before.
- **loop:** a subagent's edits no longer raise a loop alert on its parent. A
  subagent's tool calls arrive under the parent's session id, and the
  detector counted them in the parent's window: a parent and two subagents
  making the same edit, three each, read as nine repeats of one call. Each
  thread now counts its own — the main thread, and every subagent apart — and
  a subagent that really repeats itself still raises the alert on the session
  it works for. A hook fired inside a subagent with no `agent_id` is told
  apart by its transcript path (`…/subagents/agent-<id>.jsonl`). The Week
  card's longest loop counts the same way.

## [0.120.0] - 2026-10-15

### Added

- **brain:** the Second Brain banner and *How it works* show the agents you
  actually use — up to five of Claude Code, Codex, Gemini CLI, OpenCode and
  DeepSeek, from your last 30 days, drawn as Caprock's own characters (Claude
  in the face you picked, duck included) — around the brain, each line
  carrying a pulse into it: *One memory for all your agents*, with a line
  naming them (*Claude Code, Codex and Gemini CLI remember together.*).
  With no usage yet it is Claude Code alone. Both now say *Free* in a quiet
  accent pill, and the dialog adds *Free — runs on your own Claude, on this
  computer.* The pulses hold still with reduced motion.
- **app:** a release plan with progress bars — on the Pipeline, in the
  right panel and on Work. The next version your changelog entries call
  for (a feature makes a minor release, fixes a patch; hover it for how it
  was counted), then a ten-block bar per pull request merged since the last
  tag, open, or agent still at work, with its step in a word — a
  landing-queue label such as *landing: queued* when it has one, the CI
  step red when a check failed — and drafts and idle agents under *Later*.
  It is a *Next release* panel under the Pipeline's figures, a *Release*
  section in the right panel and a third view on Work beside List and
  Kanban. The right panel's sections now move by a small grip at their top
  left: drag it, press ⌥⇧↑ ⌥⇧↓ on it (Ctrl+Shift+↑ ↓ on Windows and
  Linux), or click it for Move up, Move down, Move to top and Reset order;
  the order is kept for you.
- **app:** the release check runs hourly instead of every six hours, and
  within five minutes of the computer waking; it is the same conditional
  request to GitHub, and nothing new is sent. Settings has its own
  **Updates** section: the switch, when Caprock last checked, and **Check
  now**. In the desktop app it adds a choice for a new version: **Ask me**
  (the card, as before) or **Update automatically**, which downloads the
  update in the background and restarts into it only when no agent is
  working or waiting on a permission prompt, you have left the app alone
  for two minutes, and nothing typed is waiting to be sent — with ten
  seconds' notice and **Not now**, and *Updated to vX · What's new*
  afterwards. Sessions and tabs come back as after any update. The update
  card also offers **Always update automatically**.
- **app:** a check for updates you ask for always answers. Nothing newer:
  a banner says *You're up to date — Caprock X is the latest · checked just
  now*, with **Close**, and goes after 8 seconds unless the pointer is on
  it. A failed check shows the error with **Retry**. The hourly background
  check stays silent when there is nothing new.
- **brain:** Second Brain starts in one click and you can watch it being built.
  The empty screen is one picture, *Give your agents a memory*, *Free* and
  *Start building*, with one line on what it does (your own Claude reads your
  last 30 days on this computer, up to the daily limit, nothing goes to
  Caprock) and the rest under *Details*. The click turns it on and reads the
  past month. While it builds, the screen shows the session it is reading,
  *12 of 41 sessions* with a bar, memories found counting up, today's tokens,
  where it all comes from per project, and the last reads, with *Pause* and
  the one fix for a problem (*Check again*, *Raise to 1M a day*). A build now
  reads session after session instead of four every five minutes.
- **brain:** the living brain: a slowly turning cloud of your memories with
  your agents at its rim and sparks flying into it while it reads, in the
  sidebar card and on the screen. At rest it added about 0.6% of the page's
  main thread (measured in a headless browser, 2026-10-15), and nothing while
  out of view.
- **app:** the status bar's *agent cpu … ram …* opens a popover on hover,
  focus or click: CPU and memory over the last 15 minutes or hour for the
  agent in front, all sessions and Caprock itself, each with its figure now,
  peak and average, and the sessions using the most right now, a click on one
  bringing its tab forward. The daemon keeps the samples it already takes in
  a fixed one-hour ring (`GET /v1/resources/history`): 157 KB for ten
  sessions, no new sampling.
- **app:** quick replies: under the terminal of every agent Caprock started,
  and above the chat's field, a row of small buttons sends *Continue*,
  *Shorter*, *Explain*, *Run tests* or *Commit* in one click, the way the
  composer sends. Edit the list in Settings → Terminal → *Quick replies*.
  Sessions started in another terminal never get the row.

### Changed

- **changelog:** a pull request no longer edits `CHANGELOG.md`. It adds one
  file, `changes/unreleased/<slug>.md`, holding its entry under a `kind:`
  line, and the release writes them all into the new version's section with
  `scripts/changelog.py assemble`; `scripts/changelog.py preview` shows that
  section before then, and `make docs-check` rejects a malformed file. With
  many pull requests in flight, editing one shared section made git conflict
  and, three times on 2026-10-15, put entries silently into releases that
  had already shipped. The Work page's next-release list reads these files
  too, from any repository that keeps them.
- **brain:** the sidebar's Second Brain card is one click target into the
  screen, folds to one row that says what it is doing (*Extracting from
  acme-api*, *Indexing 3 sessions*, *Idle*, *Paused*) with the count, and its
  *Start building* opens the screen instead of a wall of consent text.
- **brain:** the graph reads at a glance: memories cluster around their
  project, a dot's size is its links and its colour its kind, only projects
  and the busiest topics are named, and hovering a node lights its
  neighbourhood and dims the rest. Settings on the screen are one gear with
  three choices; *How it works* says its details in three short lines.
- **ui:** the *Take Caprock with you* strip has two buttons instead of five:
  *Set up* opens a small list of Phone and Telegram, each with its state, its
  own action and *Not needed*, and *Later* hides the strip for three days. The
  × folds it to a *0 of 2* chip in the status bar that opens it again.
- **ui:** a GitHub read that fails on the network or with a 5xx now says
  *Couldn't reach GitHub. Showing data from 6 min ago.* with *Retry*, the raw
  error and the exact time in the tooltip, and then what GitHub's status page
  reports: an outage with a link to it, or *all systems operational — likely
  your connection*. *Watch GitHub Status* in that line, off by default, shows
  a dot in the status bar while GitHub reports an incident. The daemon reads
  githubstatus.com only while GitHub is connected, with nothing about you.
- **store:** four indexes that later ones had replaced are dropped, giving
  back 125 MiB of a 1041 MiB database of 519,000 events, with every query
  as fast as before. The space returns as the database's idle vacuum runs.

### Fixed

- **app:** terminals reconnect on their own after the network drops. A
  terminal whose connection was lost retried on a single timer, and the
  only thing watching it stopped with the socket: when the browser refused
  to start a new socket once (as a network stack being swapped under it
  can), or the timer was lost, the tab said *Reconnecting…* for good and
  nothing typed reached the session until the tab was closed (user report:
  every tab stuck after a Wi-Fi drop). A terminal between sockets is now
  checked every second and always has a retry on its way and on time; a
  pause for its own backlog resumes after 15 s even if the terminal never
  reports catching up; and the window getting focus checks the connection
  at once. The badge says the attempt and the next try, and after 3
  failed tries or 10 s down offers **Reconnect now**, which reconnects the
  same session — no new process. The dashboard's live connection got the
  same watchdog and button.
- **brain:** search finds any language's letters in any case, several
  words, and small typos. Second Brain's search matched one phrase, and
  ignored case for Latin letters only, so a memory in Greek or with
  accents was missed when typed in another case. Now every word has to
  match, in any order, in a title, summary, project or linked topic, with
  case and accents ignored in every script; when little matches exactly, a
  word a typo or an ending away counts too, said as *including close
  matches*. Results come best first — title above summary above a close
  match — and the List view marks the matched words. The search box says
  what it searches.
- **app:** the terminal in front no longer turns to garbage after a long
  day of tabs. xterm's WebGL renderer shares one glyph atlas among every
  terminal, merges its pages when it fills, and after the second merge
  kept drawing from the old page's texture (the new merged page carried
  the same per-page version number as the old one): letters clipped and
  overlapped over the whole screen until font size + then −. Every
  terminal now re-sends its atlas to the GPU and redraws when a merge
  happens, and the window back in front after half a minute away does the
  same for the tab shown.
- **app:** the sidebar footer is a band of its own under the list, on a solid
  fill with a hairline on top, so the edge between the list and the tools reads
  at a glance in every palette; the list scrolls above it and its last line
  (Second Brain's *Local · your own Claude · free*) is whole when scrolled to
  the end. Folded, a key above an icon is part of that icon's button: a click
  on ⌘D, ⌘P, ⇧⌘M and the rest does what the icon does, with its tooltip.
- **pipeline:** the repository picker lists only git repositories on GitHub.
  A folder outside git (a copy in Downloads, a quick chat's folder, the paste
  folder), a repository with no remote and one on another host are no longer
  offered, so picking an entry never ends on "This folder is not a git
  repository with a remote". Two clones of one GitHub repository are one
  entry, and two entries that would read the same word show owner/name, else
  their parent folder. The *N more…* list follows the same rules, and Home's
  Pipeline card picks from the same list. New read: `GET /v1/repos/remotes`.
- **ui:** the theme picker is walked with the arrow keys, each palette shown as the focus lands on it; Enter or Space keeps it.
- **agents:** text copied from an agent (its `pbcopy`) keeps non-Latin letters: every process Caprock starts gets a UTF-8 locale when it has none, not only agent tabs, and the daemon sets one on itself at start.
- **ui:** the UI tests that turned PRs red at random pass every time. The
  chat test's live store dialled a socket nobody answered and flipped the
  link to *reconnecting* mid-test; the cockpit tests compared times drawn
  from the clock with fixtures stamped when the file loaded; the app
  workspace tests handed the dashboard a summary without `savings`, so the
  Now screen crashed whenever it drew one; and the first test to open the
  lazily loaded dashboard paid for transforming it inside its own 5 s, then
  asked for its links before they had drawn. Tests only; nothing in the
  product changed.

## [0.119.0] - 2026-10-15

### Added

- **mail:** the AI assistant works with the subscriptions you already have.
  *Summarise* and *Draft reply* can go through your own logged-in Claude
  Code, Codex or Gemini CLI (run headless, with no tools, hooks or session
  file), through an API key for Anthropic, OpenAI, OpenRouter or DeepSeek
  (kept in your keychain, never shown again), or through a local model
  server as before. *Automatic*, the default, uses the first of claude,
  codex, gemini and a local server this computer has, so with Claude Code
  installed turning AI on is the only step. Settings show which provider
  answers and where the mail text goes; it is sent only when you click an
  AI action, and the thread reaches the model fenced as data it must not
  follow.
- **app:** New project from a template — the dialog. *From a template…* in
  New project's footer or ⌘K: pick a saved template or look one up
  (`owner/name`, its link, or a folder), name the project, paste or drop
  the brief, and the box under it says what *Create* will run and send
  (the name and visibility, to GitHub, through your own `gh`; nothing
  without it). Progress shows in the footer; Esc hides it and the agent
  still starts in its own tab when the project is ready. A failed clone
  offers *Try the clone again* and *Open on GitHub*. Settings → Project
  templates edits and removes them. In the app a dropped `.md` or `.txt`
  becomes the brief (`read_dropped_text`, only from the latest drop).
- **projects:** start a project from a template — the daemon side. Add your own template (a GitHub template repository,
  a folder, or both) with where its brief goes and the agent's first
  prompt; Caprock reads its `TEMPLATE.md` to fill those in. Making a
  project from it runs your own `gh` on your click (`gh repo create
  --template`, then `gh repo clone`), or copies the folder's last commit
  into a new repository when you pick the local copy, then writes your
  brief and commits it — never pushed. A failure takes away only the
  folder Caprock made and never deletes a repository on GitHub; Retry
  picks up where it stopped (ADR-065).
- **pipeline:** every figure on the Pipeline page — and the five on Home —
  shows its last 14 days as a small line, with today set against them
  underneath: *usual*, *above usual +38%*, *below usual −30%*. In flight,
  throughput, the CI median, opened → merged, merged → released and the
  agent cost each get one; green where today is the better side (a shorter
  CI run or merge, more merges), amber the worse, muted for the open count
  and the cost. Running totals compare today so far with earlier days at
  the same hour; a day with nothing to measure is a gap, not a zero; with
  fewer than three earlier days of data it says *not enough history*.
  Hover a day for its value, or the word for what it is compared with.
  Counted from what the Pipeline already reads: no new GitHub request.

### Changed

- **app:** the Pipeline has its own tab again, pinned with the system tabs
  right after the Dashboard tab and before Mail, drawn like them: its glyph
  and ⌘P (Ctrl⇧P on Windows and Linux), its × while it is in front. ⌘P,
  *Pipeline* at the foot of the sidebar and *Open Pipeline* in the palette
  bring it to the front, and again go back to where you were; ⇧⌘B still
  works and ⌘B stays the Pipeline bar. It stays in the Dashboard too:
  *Pipeline* in its menu and *Open Pipeline →* on Home take you to that
  tab, so the page is drawn once and, behind other tabs, reads nothing. The
  tab is kept across restarts.

### Fixed

- **phone:** Settings → Use on your phone tells you how to get back to a
  phone you already paired. Each paired phone says *Already paired — just
  open m.caprock.dev on that phone*, and **Open on the phone again** shows
  a QR code of that address (the address only: no code and no key, so it
  pairs nothing) and the Add to Home Screen tip. With a Telegram bot set up,
  **Send the link to my phone** sends the address to your Telegram chat
  through your own bot, and says so before you press it.

## [0.118.0] - 2026-10-15

### Added

- **app:** a live session's row on Home takes you into the running session.
  Click anywhere on the row (or Enter on it) and the session's tab comes to
  the front, as its ⌘N does, or opens if it has none; *Go to session ↗* with
  the tab's key shows on hover, and *details* still opens the session page.
  A session started in your own terminal says *in your terminal* and offers
  *Continue in Caprock*: a new process on a copy of the conversation, in a
  new tab, leaving the one in your terminal untouched. An idle session
  Caprock started gets a small **× End**, which asks first only when
  messages wait in its queue; a working session and one your terminal
  started never do. In a browser the row keeps its *open* link.
- **work:** the Work page — every piece of work on the machine on its way to
  a release, one row per branch at its furthest stage, grouped Next release,
  In review, In work, Planned and Released, or as Kanban columns. Each row
  has a bar along agent → PR → CI → merged → released filled to its stage
  (red when CI failed or it conflicts), who works on it (the agent and
  model, started by Caprock or your terminal), elapsed time and agent cost
  at list price. Estimates appear only with a measured basis: a turn's
  rough range, CI against its median, merge to release against the median
  lag, and the gap since the last tag against the usual gap. Rows that
  need you come first; agents idle for over 30 minutes fold into one line.
  It is second in the Dashboard's menu (⇧⌘W; Ctrl+Alt+Shift+W on Windows
  and Linux, and again back to where you were), and Home shows its headline
  and first rows above the Live pulse with *Open Work →*. A session row
  brings that session's tab to the front; a pull request's title opens it
  in the Pipeline with its detail open.
- **work:** The Work board's daemon answer, `GET /v1/work` (ADR-064): every
  live session on the machine — started by Caprock or by hand — with its
  state, its running turn's rough range (Claude Code only, never while it
  waits on you), its own task list, what it cost today and the pull
  requests it recorded; the task runner's tasks and the queued messages;
  and each repository's `[Unreleased]` CHANGELOG entries, newest tags and
  commits past the last one, read from local git as of your last fetch.
  Nothing is written, nothing is polled, GitHub is not asked and git never
  fetches. The screen comes next.
- **pipeline:** The PRs & CI board's flow strip carries how often the
  repository ships: the median gap between its releases already read
  (`release_gap_median_ms`, with three gaps or more), never a date for the
  next one.
- **app:** a Sunlight theme for working in bright light. It is black text
  on pure white with no faint greys: every text colour, the faintest
  included, is 7:1 or more against its background, measured on every
  surface. Text is one weight heavier, borders and hairlines are dark
  enough to see in glare, and the sidebar is opaque. The status colours
  and the accent are saturated and stay apart. Its terminal keeps all 16
  ANSI colours at 5.3:1 or more on white (the normal eight 7:1), the
  yellow and cyan that usually wash out included. Pick it under Light in
  the theme picker or Settings → Appearance.

### Changed

- **app:** where you type is easier to find, quietly. The Chat view's field
  carries a hint of the accent at rest — a faint tint and a hairline edge,
  a little stronger with the focus — on every theme and terminal palette.
  In a Claude Code terminal, the rows of its input box (between the two
  rules, at the `❯` prompt) sit on a faint band of the terminal's own
  background, lifted a step: it follows the box as it grows or moves, leaves
  any cell Claude Code coloured alone, reads only the bottom rows of the
  screen, and draws nothing for other agents, shells, dialogs and menus.
- **app:** keys named after what they open. ⌘D opens the Dashboard (⌘0
  still does), ⌘P the Pipeline (⇧⌘B still works), ⇧⌘T the theme picker,
  and ⇧⌘W Work; ⌘F stays Find and ⌘T New shell. On Windows and Linux they
  are Ctrl+Shift+D, Ctrl+Shift+P, Ctrl+Alt+Shift+T and Ctrl+Alt+Shift+W —
  never Ctrl+D, which stays the shell's end of input. The sidebar's footer
  shows *Dashboard ⌘D*, *Pipeline ⌘P* and the theme's ⇧⌘T, folded or not,
  and the palette, the shortcuts list and the tooltips say the new keys.
- **dashboard:** The Pipeline is a page of the Dashboard now, beside *Week*
  in its menu, instead of a tab of its own: ⌘P and *Pipeline* in the
  sidebar open the Dashboard tab there (Ctrl+Shift+P on Windows and
  Linux), and again go back to where you were. It shows one repository —
  the agent in front's, else the one you looked at last — with buttons
  beside its title to switch. It is drawn as the Dashboard is: its figures
  are the Dashboard's tiles, larger and readable, each explained in a card
  under it on hover rather than a tooltip over the number; every pull
  request's whole title; and its four steps tell done (ticked), current
  (filled, ✗ when red, a turning ring while CI runs) and still ahead
  (outlined) apart by shape as well as colour. A pull request's detail
  opens beside the list. Home's CI/CD section shows the Pipeline's first
  five figures at its top — in flight, needing a fix, ready, throughput,
  CI median — with *Open Pipeline →*. A Pipeline tab saved by an earlier
  version opens as the page.
- **ui:** Get premium in the header is a quiet tinted button, not a bright
  block: the same height, radius and type as Feedback and Settings beside
  it, a faint premium tint with a hairline border and premium-coloured text,
  the price a step fainter, a little stronger on hover. Its text reads at
  4.5:1 or more in every palette.

- **brain:** Second Brain looks like what it is: a brain made of a graph.
  Nodes and links in the side view of a brain, in the memory kinds'
  colours, softly pulsing, with a new node dropping in now and then and
  linking up (still with reduced motion; CSS only, nothing runs in the
  background). *How it works* is big and short — *Your agents' memory*,
  one line on what it does, three one-line steps, *Over time: your
  personal Jarvis*, one line on privacy and one button; the defaults
  (Haiku, 300k tokens a day, up to five memories) moved into a folded
  *Details*. The empty sidebar banner leads with the same brain, *Give
  your agents a memory*, *Start building* and *How it works*.

### Fixed

- **picker:** an arrow key pressed in the folder picker the moment a
  folder's entries appear is no longer lost; the selection used to be
  cleared just after it was made.
- **app:** the theme picker opens whole, above everything. From the
  sidebar's footer its palettes were cut off at the sidebar's edge and the
  terminal drew over them; it now opens over the whole window, kept inside
  it on every edge at any sidebar width and with the footer folded, and
  scrolls in a window shorter than itself. Opening it puts the focus on the
  palette in use; Esc, or tabbing past the last palette, closes it and gives
  the focus back to the button.
- **app:** the sidebar footer's shortcuts are readable. Folded, the keys
  above the icons were small faint 10px chips; now every key in the footer
  is the New agent chip's size, folded or not. Where one has no room —
  beside a row's words, or over a folded icon — it is left out whole
  rather than drawn smaller, and the key stays in the tooltip: a row
  measures itself and brings the chip back when it widens. Off macOS the
  folded keys still show on hover, now at full size.
- **mail:** the Caprock Mail preview app reloads onto Caprock's new page
  after Caprock updates (it used to keep showing the page from before the
  update when the port stayed the same), and a click on its Dock icon
  brings the window back.

## [0.117.5] - 2026-10-15

### Added

- **brain:** Second Brain's status says when the reader wakes next
  (`next_wake`), so a screen can tell you when the first memories may come
  instead of leaving you at 0. Turning building on still wakes the reader
  at once, and a double click or a second yes never starts a second read
  beside the first.
- **mail:** Mail on its own. `<daemon>/?mail=1` is the inbox and nothing
  else of Caprock — no sidebar, no tabs — titled *Caprock Mail*.
  `app/mail-mac` builds a Mac preview app around it: Caprock's icon with an
  envelope in place of the dot, one window on the running Caprock, so the
  accounts and mail are the same as in the Mail tab. It waits for Caprock
  when it isn't running and follows it to a new port.

### Changed

- **brain:** the sidebar's Second Brain block is a small banner while it is
  empty, instead of a bare 0 and two faint lines: a faint graph breathing
  (still with reduced motion), *Remembers what your agents learn — so the
  next one starts smarter.*, **Start building** and *How it works*, and
  *Local · your own Claude · free*. **Start building** asks in place —
  your own `claude` and its model, on this computer, the daily token
  limit, where the prose goes, and that Settings turns it off — and only
  **Turn on** switches it on and starts on your last 30 days of sessions,
  within that limit; without Claude Code it says so and offers no
  button. Once on and still empty it says what it is doing: *Reading your
  recent sessions…*, or how many sessions are waiting, and the last
  problem if there was one. The same line replaces *your personal Jarvis*
  under the Second Brain screen's title.
- **brain:** Second Brain's *How it works* now explains it in ten
  seconds. *Remembers what your agents learn — so the next one starts
  smarter*: it keeps the decisions, findings, ideas and open questions
  your sessions arrive at and hands the relevant ones to the next agent
  you start — over time, your personal Jarvis, an assistant that knows
  your projects. Three steps say how (a session ends → your own `claude`
  reads it on this computer, Haiku and 300k tokens a day by default →
  up to five memories go into the next session's handoff), and one line
  says that nothing leaves the computer except that call and where to
  turn it off.

### Fixed

- **app:** typing a name in New project's folder field now searches the
  folder it is in. `~/dev/cap` used to empty the list; now it lists the
  folders of `~/dev` holding *cap* — the ones starting with it first, the
  letters marked — and every key narrows it at once. The first match is
  highlighted: ↑↓ move, Enter picks it, Tab completes to it and goes
  inside. No match says *No folder starting with 'cap' in ~/dev*. Works
  with `~`, backslashes and drive letters on Windows.
- **windows:** Caprock no longer flashes console windows that steal the
  keyboard focus. The daemon ran without a console, so every git, gh or
  `claude -p` it started opened a window of its own for a fraction of a
  second, every few seconds, and typing in other windows came out ragged
  (user report on Windows 10). Every child now starts with a hidden
  console, and a test keeps it that way.

- **mail:** adding an account can no longer sit on *Checking…* forever. A
  server that goes quiet while Mail connects or signs in — IMAP had no limit
  and SMTP waited five minutes per command — now ends the check within 30
  seconds with what happened: which server stopped answering, and that
  another mail app open on the same account can count against the server's
  connection limit. A synced mailbox still waits in IDLE as long as it
  needs; the limit is lifted once signed in.

## [0.117.4] - 2026-10-15

### Changed

- **alerts:** a loop alert is now one sentence and three actions. It
  says what happened — *caprock ran the same command 5 times in 3
  minutes (python3 …/p2e.py)*, the whole command on hover — with the
  costs quiet underneath. **Tell the agent** shows a message marked
  *[Caprock]* and signed as sent by Caprock's loop alert, which you can
  edit, then puts it in that session's queue so the agent reads it when
  its turn ends; it is offered only on sessions Caprock started, and a
  session you started yourself gets **Open session** instead. **Dismiss**
  has a menu with *Don't warn about this command again in this session*
  and the one remaining cap link, *Set a spending cap…*. The same card is
  on Now, in the agent cockpit and on the session page.
- **brain:** it is called *Second Brain* everywhere it is named — the
  sidebar block (*SECOND BRAIN*), the dashboard's screen row, the screen's
  title, ⌘K (*Second Brain*, *Add to Second Brain…*) and *Drop into Second
  Brain* — with a brain outline as its mark (it was a drop falling into a
  bowl, which did not read as a brain) beside the name, and one faint line under it in
  the sidebar and on the screen: *All your agents build your personal Jarvis
  over time.*
- **app:** the chat button in the tab strip says what it is: a speech
  bubble and the word **Chat**, as Deck has its word, lit while the chat is
  shown. Its tooltip says what the chat is: this session as messages —
  your prompts, the agent's replies, one line per tool call — and a field
  that types into it, while the terminal keeps running.

### Fixed

- **app:** terminals no longer show rows of wrong letters ("ι ɤr ·r")
  after another tab redraws its glyphs. All terminals share one set of
  drawn glyphs; when one tab rebuilt it (back after five minutes, after the
  Mac woke, on a display change) the others kept pointing at places in it
  that now held other letters, until their rows were drawn again — for a
  couple of seconds after closing a tab or leaving the chat, or for good in
  a tab that printed nothing. Every terminal now redraws from the new set
  at once, and a tab coming back into view sends its glyphs to the GPU
  again. Under the chat (and under Changes or a comparison) the terminal is
  put away as a tab behind another is: what the agent prints meanwhile is
  drawn at once when you come back.
- **app:** a terminal no longer opens with its letters spread far apart
  after the app restarts (an update): a letter cell measured before the
  terminal's font settled was kept until you changed the font size. A cell
  no monospace font could have is now measured again on its own, when the
  fonts are in, when the window comes back and when the tab is shown.

## [0.117.3] - 2026-10-14

### Added

- **pipeline:** ⇧⌘B (Ctrl+Alt+Shift+B on Windows and Linux) opens the
  Pipeline in a tab, or brings it to the front; pressed again there, it goes
  back to the tab you were on. *Open Pipeline* is in ⌘K too.
- **cockpit:** the CI block's *PRs* view shows the repository's pull
  requests as thin progress bars toward a release — Open → CI → Merged →
  Released, CI in its check colour — with each one's number, title and time
  on its step. It scrolls; *Expand* makes it taller and is remembered;
  *Pipeline ↗* opens the page.

### Changed

- **brain:** Second Brain is free, all of it. There is no cap on the
  memories you drop in by hand (it was twenty without a licence), and the
  automatic build from finished sessions works for everyone who says yes —
  it runs on your own `claude`. The Brain screen asks everyone once; the
  sidebar's Brain block starts unfolded, with no lock, and *How it works*
  explains it and opens the Brain screen. A Premium licence bought for
  Second Brain stays exactly as it was, with every other Premium feature.
  `GET /v1/brain/status` no longer carries `licensed`, `free_max` or
  `free_left`, and no Second Brain route answers `402`.
- **pipeline:** *PRs & CI* is now **Pipeline**, everywhere: the tab, the
  sidebar footer, the palette, the deck. Tabs you had open come back under
  the new name. The page is one list of pull requests instead of a board
  and a list: each row its number, its whole title, its labels, and the
  steps Open → CI → Merged → Released as pills, the one it is on
  highlighted, then its agent cost. In flight first, then merged, then
  released (ten, then *Show more*). Click a row for its detail over the
  page; × or Esc closes it. The red-runs and Actions-minutes figures went
  with the old list.
- **app:** the sidebar footer's button is *Pipeline*: a click opens the page
  or goes back from it. Showing or hiding the bar under the agent is now on
  the bar itself (*Pipeline* and ×), ⌘B, and *Pipeline bar: On/Off* in ⌘K.

## [0.117.2] - 2026-10-14

### Added

- **mail:** **Import everything.** Mail lists the mail accounts it can
  read on the computer — Thunderbird, and Apple Mail including the Google,
  iCloud and Exchange accounts in System Settings › Internet Accounts —
  each address once, under the app it came from and when that profile was
  last used (accounts from a profile unused for 90 days start unticked). An
  app it cannot read is not shown. Tick them and press *Import*: accounts with a saved
  Thunderbird password connect by themselves, then each other account asks
  for its one sign-in in turn (Google or Microsoft in the browser, an
  app-specific password for iCloud, otherwise the password), with a
  progress list of connected, waiting and failed accounts, *Retry*, *Skip
  for now* and *Come back*. A build without Google or Microsoft sign-in says so and asks for
  an app password instead of showing a button that cannot work.
- **release:** Mail's Google and Microsoft client IDs are compiled into
  releases from the `CAPROCK_MAIL_GOOGLE_CLIENT_ID`,
  `CAPROCK_MAIL_GOOGLE_CLIENT_SECRET` and `CAPROCK_MAIL_MICROSOFT_CLIENT_ID`
  GitHub secrets, the desktop app's daemon included; unset, a release still
  builds.
- **now:** each figure in *Today* has a small line of your last 14 days and
  one word against your own median: *usual*, *above usual +38%*, *below
  usual −20%*. Running totals (cost, sessions, turns) are compared by the
  same time of day, so a morning no longer reads low against whole days;
  *Burn now* is set against your typical 10-minute window while working.
  Cache hit gets the line only. Hover says what it is compared with; under
  five days of history it says *not enough history*. It follows the agent
  filter. New endpoint `GET /v1/stats/trends`.

- **brain:** Second Brain builds itself, once you say yes. When a
  session has been quiet for ten minutes, your own `claude` (Haiku, no
  tools, no transcript, none of your hooks) picks out what it decided and
  found, and each memory links back to the passage it came from. A daily
  token limit (100k, 300k or 1M), short sessions skipped, failures retried
  later; *Build from my last 30 days* shows an estimate first. Settings →
  Second Brain shows what it used and read. A new session's handoff now
  carries up to five of the repository's memories.
- **app:** Caprock may also ask about a feature it is considering — running
  Hugging Face models on your computer, and one of watching short ads to
  earn money or YouTube while agents work. At most one strip a day; each
  question is two clicks and an optional email. Nothing leaves the computer
  until you press **Send**, which sends those answers to caprock.dev and
  nothing else; *Not interested* and × send nothing, and an answered strip
  never returns.
- **brain:** Second Brain drawn. The Brain screen opens on a graph of your
  memories and their topics and projects — drag, zoom, click a dot to open
  it, *List* for rows — smooth with thousands of memories. The app's
  sidebar has a Brain block below the projects: the newest thirty as a small
  graph where each new memory drops in, and the three newest titles. The
  strip that offered Second Brain ahead of its arrival no longer shows.

### Fixed

- **prs:** the PRs & CI board follows merges and releases instead of
  freezing. With a dozen open pull requests whose checks were running, the
  daemon read each one's state one after another, ran past its deadline on
  every refresh, and the board kept showing its afternoon answer for hours —
  merged pull requests still under *CI running*, new releases missing —
  behind a bare *updating…*. The open pull requests are now read four at a
  time within a budget, the board's answer always comes back (a card whose
  checks could not be read again in time is drawn faint), and releases are
  read every 2 minutes instead of 10. The header always says how current
  the data is: *Updated just now*, *Saved 5 h ago · refreshing…* while a
  kept copy is read again, or *Couldn't refresh: <why> · showing data from
  15:02 · Retry*; the CI/CD section on Now says the same. A refresh that
  keeps failing is no longer retried on every poll.
- **ui:** selected text stays readable in every theme. In a terminal,
  Claude Code's own selection (fullscreen mode) painted its highlight in the
  palette's blue, which in a dark palette is light, under light text — in
  Dark Pastel 1.6:1, nearly invisible. Every terminal palette now keeps text
  at 4.5:1 or more against whatever is behind it, as the light ones already
  did. Selected text on the page sits on a lighter wash of the accent (20%,
  was 35%), written out per palette: body text 8:1 or more, muted text
  4.3:1 or more.

- **phone:** a paired phone stays paired. A dropped connection, a computer
  or relay restarting, a phone asleep or offline, a computer still on an
  older Caprock, or a QR opened twice no longer send the phone back to
  *Settings → Use on your phone*. Three causes: a phone hanging up in the
  middle of an answer took the computer off the relay for every phone; the
  relay could hand the next phone a stray message meant for the one before,
  which the page read as "not your computer"; and the page believed a
  single bad answer. Now the page asks to pair again only when the computer
  has turned the phone away on two separate connections, or refused it
  three times in a row, and it still checks once a minute and comes back by
  itself if that was wrong. Needs the new page at m.caprock.dev and the
  relay redeployed; the computer's half comes with the next release.
- **status:** an agent you set going no longer reads *waiting for you*
  for seconds after. Answering a permission prompt — a key in the
  terminal, the card's buttons, the phone, Telegram — shows it working at
  once (*approved — running …*), instead of when the allowed command
  finished; answering No shows it waiting for you. Enter at its prompt
  shows *starting on your message* straight away, and goes back if
  nothing was sent. Every screen (sidebar, tabs, cockpit, tray, phone)
  now updates a session's status as soon as it changes rather than up to
  two seconds later, and a Codex or Gemini session you type into is read
  at once instead of on its next poll. Measured with a test agent: a
  prompt to *working* about 1 s → under 10 ms; an approved 15 s command
  16 s → under 10 ms.

## [0.117.1] - 2026-10-14

### Added

- **now:** the tokens beside each pull request's cost in the CI/CD
  section (*9.4M tok · $2.12*); the hover splits input, output, cache read
  and cache write.

- **brain:** Second Brain. Keep the answers worth keeping as memories — an
  idea, a decision, a finding, an open question — each linked to its
  project, its topics and the moment in the session it came from. **Drop
  into brain** sits under every answer on Memory, in a session's Answers
  and in the chat view; ⇧⌘H (Ctrl+Shift+H on Windows and Linux) or ⌘K →
  *Add to brain…* takes a line of your own. *Brain* in the screen row
  searches them by words, project and time, and opens one to edit, pin,
  link to a topic or delete. Twenty memories are free; Premium keeps every
  one. Kept in Caprock's database on this machine.

### Fixed

- **app (macOS):** macOS no longer asks for the microphone (and for
  Desktop, Documents or Downloads) again after every Caprock update. The app
  and its daemon are now signed with one Caprock certificate that stays the
  same across releases, instead of an ad-hoc signature macOS saw as a new
  program each time. The first update to this release asks one last time;
  later updates keep your answers. Opening the app the first time is
  unchanged: it is still not signed with an Apple Developer ID.
### Changed

- **phone:** a session's header is one 44px bar: back, the title, a dot for
  its state, and **Chat | Terminal** with **···** for the other views. The
  project, permission mode, model, controls and details are a tap on the
  title away. In the chat the bar is drawn over the conversation and slides
  away while you scroll down, back on scroll up or a tap at the top, so the
  text never jumps. On the relay page at 390×844 the conversation began
  178px down the screen (the computer bar and three header rows); now 44px,
  and 0 while the bar is away (owner, 2026-10-14, translated: "I want the
  header to take minimum space because I need to read this chat").
- **phone:** the relay page's computer bar ("DimaS-MBP ▾") is gone while the
  connection is fine and one computer is paired. It comes back while
  connecting or offline, and with several computers paired it shows outside
  a session; inside one, the switch is in the title's sheet.
- **chat:** the message field glows softly in the accent while it has the
  focus, a little more once there is text in it; on the phone and the
  desktop alike.
- **now:** *Live activity* is now **What happened**: the moments of your
  sessions instead of every command. Files edited (grouped by folder), tests
  and checks with their result (*passed*, *failed (exit 2)*, or *no result
  recorded* when there is none), builds, commits with their message, pushes,
  pull requests opened or merged, subagents by their task, a turn ending with
  the first line of the reply, a session waiting for approval, and a command
  that failed. Reads, searches and the like are a quiet `+N` on the moment
  they led up to. On one day of real use that is 1,974 rows where the old
  feed had 11,493. *All commands* brings the old feed back; the panel folds
  like the others and remembers it; every row is the same height.
- **app:** the sidebar's bottom block reads more clearly. *Dashboard ⌘0*
  has a row of its own again; under it, one row in two halves: **PRs &
  CI** named with its mode (*CI Off*, *CI Bar*, *CI Page*; ⇧⌘B in its
  tooltip) and the **theme** with its name. On Windows and Linux the two
  take a row each, and PRs & CI shows its key, Ctrl+Alt+Shift+B.
- **app:** folded, the bottom block's icons are a size bigger, and on a
  Mac each one has its key drawn small above it (⇧⌘F, ⇧⌘M, ⌘0, ⌘,
  ⇧⌘B). On Windows and Linux the keys are too long for that and show
  above the icon you point at.

### Fixed

- **phone:** dictation listened only for the browser's language, so Russian
  speech came out as English words. A chip beside the microphone (**EN**,
  **RU**…) says the language and changes it: a tap moves through the
  browser's languages, then opens a list of common ones (English, Russian,
  Ukrainian, German, French, Spanish, Portuguese, Italian, Polish, Turkish,
  Japanese, Chinese, Korean, Arabic, Hebrew). Remembered per viewer; shown
  prominently once when the browser names more than one language.

- **now:** the activity feed no longer says "session ended" at the end of
  every turn and every subagent's stop; it says *finished its turn* or
  *subagent stopped*, and "session ended" only when one did.

- **phone:** a phone can type the moment it pairs. A newly paired phone
  could only look until a second click on the computer — impossible once
  you have left the house. Settings → Use on your phone now has **This
  phone can type and start agents** beside **Show a code**, ticked by
  default and remembered on the computer; the code carries it, so the phone
  pairs ready to work. Untick it for a phone that should only look. The
  panel lists the steps one line each and, while the code is up and after,
  ticks off what is done and what is left: access from anywhere, the phone
  paired (by name), whether it can type (with **Let it control sessions**
  right there if not) and whether the app is installed on it. The phone
  opens on a short **Ready** card — connected to which computer, whether it
  can type and, if not, exactly where on the computer to fix it, the
  install button, and **Open sessions**. m.caprock.dev needs a redeploy
  for the phone's half.

- **now:** the CI/CD section lists only repositories with a session in the
  last 14 days, most recent first. Older ones, and any you hide from a
  block's new ⋯ menu (*Hide from CI/CD*), fold into one quiet line —
  *3 older repositories · 1 hidden — show* — and are not read from GitHub
  until you show them; hidden ones come back with *Show again*.
- **now:** GitHub no longer runs out of time on the CI/CD section: the
  repositories are read three at a time, each with its own 12 seconds,
  instead of one after another under a single deadline that left every
  later one *context deadline exceeded*. A slow GitHub is one grey line —
  *GitHub didn't answer in time — retrying* — once for the section when
  every repository says the same, and the names show at once while the
  figures load.
- **now:** a session that drove many pull requests is no longer charged
  whole to the one whose branch it ended on. It is split between the pull
  requests it worked on, and such a row says *shared*; the release pull
  request #601 read as $1,884.29, the whole orchestrating session, and now
  reads $2.12 (measured on the owner's database). This also corrects the
  PRs & CI Board's agent cost.
- **app:** on Windows and Linux the *Settings* row's words no longer run
  under *phone, Telegram*, and *Send feedback*'s key is no longer cut
  off at the sidebar's edge.

### Changed

- **app:** the dashboard keeps its place. Switch to a terminal tab and back,
  or from Home to Cost and back, and each screen is where you left it:
  scrolled to the same spot, with the Live pulse rows, panels and folds you
  opened still open. A screen out of sight asks the daemon nothing.
- **app:** ⌘0 (Ctrl+Shift+0 on Windows and Linux) brings the dashboard back
  where you left it; pressed again, it goes to Home at its top. The
  sidebar's *Dashboard* row does the same, and *Home* in the dashboard's
  bar scrolls Home to its top.
- **ui:** the main dashboard screen is called **Home** (it was *Now*), in
  the bar, the palette and the back links. `#/home` opens it; old `#/now`
  links still work.

## [0.117.0] - 2026-10-14

### Added

- **app:** closing the tab of an agent Caprock started now asks: **Close
  tab** (in focus, so ⌘W then Enter works as before and the agent keeps
  running) or **Close and end the agent**, which stops it (asking once
  more if it is still answering; the conversation is kept). Tick *Don't
  ask again* to keep your answer; Settings → *Closing a tab* changes it
  back. An agent you started in your own terminal is never ended from
  Caprock: its tab just closes.
- **app:** in the Tabs list, sessions running with no tab sit under a
  quiet *Running, no tab* line, so an agent whose tab you closed no
  longer looks like an open chat.
- **app:** a Mail button with its own key. *Mail ⇧⌘M* in the sidebar's
  bottom block (Ctrl+Shift+M on Windows and Linux) opens Mail in a tab of its
  own beside the Dashboard tab; pressed again it brings it to the front. With
  no account yet it opens straight on a sample inbox, with a line on top and
  *Add account* (Google, Microsoft, iCloud, Other, import); adding your
  account leaves the sample. Also in the palette as *Open Mail*.
- **app:** Send feedback opens with ⇧⌘F (Ctrl+Alt+Shift+F on Windows and
  Linux) from anywhere in the app, and its row in the sidebar shows the key.
- **cockpit:** put the sections in your own order. *Arrange sections*
  under the last one lists them with ↑ and ↓ for each, *Reset to default
  order* and *Done*; nothing moves by dragging a heading, so it never
  happens by accident, and the order is kept for you.
- **cockpit:** every section folds to one line on its label, like Context
  and Plan — Now, Subagents, Tasks, Recent tools, Changes, CI and
  Processes — and stays folded or open as you left it. CI and Processes
  can be arranged with the rest.
- **cockpit:** rubber ducks. Eight of them sit beside Claude's faces —
  classic, debugger, on call, party, pirate, hacker, sleepy and rainbow —
  on a new *Ducks* tab in the menu a click on the portrait opens. Settings
  → Appearance → *Claude's face* can make every session a duck (*A duck
  per session*) or mix them in (*Faces and ducks*); the default stays the
  eight faces, and every session keeps the face it already had. Now and
  then an idle Claude asks "try a duck?" beside its portrait: at most once
  a day, never while you type or a prompt waits, and never again once
  you have seen the ducks or closed it twice.
- **app:** New project in three big steps. ⌘O, *Add project* or *New
  project…* in New agent: pick a folder (a place such as `~/dev`, then a
  click on the folder; *Choose…* opens the system's folder picker in the
  desktop app), see what is there — *One repository*, *3 repositories* as
  cards all ticked for one multi-repo project (or one each), or a plain
  folder — and *Start an agent here*. A folder inside a repository is that
  repository, with no question. The same step says whether the repository
  already has a `CLAUDE.md` or `AGENTS.md` (*Show* reads it) and takes
  optional instructions for every agent there. Clone and a new empty folder
  are in its footer.
- **app:** what a project's agents are told is in sight. New agent shows a
  bigger block, *Project instructions — Set · 12 lines* or *None*, and the
  repository's own `CLAUDE.md` / `AGENTS.md` (members' too), each read on a
  click and Caprock's edited in place; the project's page shows the same,
  and its sidebar row's tooltip says it in words. A multi-repo project's
  repositories are named under the Project field (*3 repos: api, web,
  infra*). The daemon lists the files on each project and returns their
  text from the folder scan (`instruction_files`).

### Changed

- **now:** an opened Live pulse row is calmer and says more. Terminal,
  Open repo and Open session are quiet links at the end of the project's
  line instead of a row of bright buttons, and the empty space beside each
  live session now shows its cost, its last hour, how long it has run, its
  context, its branch with lines added and removed, and its pull request
  with CI. The legend can be hidden; the **?** in the panel's header brings
  it back.
- **app:** the PRs & CI view has one button, at the foot of the sidebar
  beside *Dashboard*: its picture shows the mode — Hidden, Bar (the session
  deck under the agent's terminal) or Full page (the PRs & CI tab) — and a
  click moves to the next. ⌘B and ⇧⌘B work as before and the button
  follows them. The deck's own *Expand* and *Hide* buttons are gone. The
  theme button moved beside it, out of the Settings row.
- **cockpit:** Recent tools says something. Each call shows what it acted
  on — a file relative to the project, or a command's program and first
  words instead of the variables set ahead of it — and how it ended: a
  quiet ✓, *exit 1* or *error* in red, the time only when it was slow,
  and how long ago. The same call repeated in a row is one row with ×N.
  The bar beside each call is gone, and the count in the heading now says
  what it counts (*31,713 this session*).
- **cockpit:** CI's *OS* view is now *By OS* and shows the newest pull
  request's checks per runner — *Linux ✓ passed 1m 48s*, *Windows ●
  running* — without opening its row in the deck first; each of the three
  tabs says what it shows on hover.

- **phone:** one way to pair a phone: from anywhere. Settings → Use on your
  phone → **Show a code** now turns on access from anywhere (the encrypted
  relay) in the same press — a line under the button says so — and the QR
  works on Wi-Fi and mobile data alike. The Wi-Fi / Tailscale address
  choice, the *Same Wi-Fi* step and *Keep on after Caprock restarts* are gone
  from the panel. A phone paired on a home-network address worked on that
  Wi-Fi only, and nothing said so when it went dead on mobile data. For a
  machine without internet, `caprock up --lan` and `caprock pair` still pair
  over the Wi-Fi from a terminal.

### Fixed

- **agents:** a permission prompt you answered from a button no longer
  comes back if the daemon crashes a moment later. The answer cleared the
  stored prompt in the background, so a crash before that write landed
  restored buttons for a dialog already answered; the answer now returns
  only once the stored prompt is gone.
- **app:** the PRs & CI bar's header no longer runs past its right edge
  when the sidebar and the cockpit are both open on a laptop screen: the
  least useful words drop first and the rest wraps to a second line.
- **phone:** m.caprock.dev says where you are. The name Caprock and
  caprock.dev stand beside the mark, a line says the page is the other half
  of the Caprock app on your computer (with where to get it), and the first
  step shows a small picture of Settings → Use on your phone → Show a code.
- **phone:** the phone no longer sits on *Connecting…* with nothing after
  it. A computer that went to sleep kept its relay connection open on
  paper, and the relay handed the phone to it; the phone waited forever for
  an answer. The relay now treats a computer it has not heard from in 75
  seconds as offline (`caprock remote relay` and the hosted relay, which
  needs a redeploy), and the phone gives every attempt 10 seconds, checks
  the computer itself, not only the relay, while connected, and after 5
  seconds says what is wrong — *Your computer is offline or Caprock isn't
  running*, *Your computer isn't answering*, *Can't reach the relay*, *This
  phone was removed: pair again* — with **Retry** and **Pair again**. It
  retries by itself, and at once when you come back to it.
- **phone:** Caprock installs on an Android phone once, when you press
  **Install the Caprock app** on m.caprock.dev. Chrome's own install prompt
  no longer pops up in a browser tab of an already-installed app, a browser
  tab says *Caprock is on your home screen* instead, and the old Wi-Fi link
  no longer offers a second home-screen icon: it says to use the app from
  m.caprock.dev. Opening the same pairing QR twice keeps the pairing that
  worked, and a page left open across a new version of m.caprock.dev
  reloads instead of failing.
- **mail:** Mail opens instead of failing with "null is not an object
  (evaluating 't.accounts.length')". A mail client found on the machine with
  no accounts it could read — Apple Mail before Full Disk Access — came back
  with a null list, and the first-run screen crashed counting it.
- **app:** the closing questions' buttons read on one line. "Keep it
  running, close tab" broke over two lines and "Stop and close" spilled out
  of its button; the sheets are wider, every sheet button keeps its label on
  one line, and the row wraps as a whole on a narrow window.

- **app:** a tab's project name fits. It was cut at nine characters
  (*uncensor…*, *creatos_f…*) even on a wide window; now it takes its whole
  width first and the session's name is shortened before it, and tabs grow
  to 340px when the strip has room. When many tabs leave too little even
  for that, the name ends in an ellipsis and scrolls into view inside its
  own space while you point at the tab, so nothing in the strip moves
  (with reduced motion it stays cut; the tooltip names it in full).
- **cockpit:** moving the mouse over CI's pull requests no longer opens a
  card over the panel. The list of checks opens only once the pointer
  rests on a row, beside the panel, and closes as soon as it leaves.
- **phone:** every hint on the phone now says where to go: the Caprock app
  on your computer, Settings → Use on your phone, and the button by name.
  "This phone can read but not type. On the computer: Settings…" left out
  that the setting is in the Caprock app, and two hints still sent you to
  "Settings → Phone", which does not exist.
- **doctor:** stopping several orphans at once reports every one of them.
  A process that was no longer on the list and one that could not be
  stopped were recorded at the same moment, and one of the two could drop
  out of the result, so a process left running was not reported as failed.
- **phone:** a phone still on a Wi-Fi link now hears about it. Settings →
  Use on your phone → *Paired devices* says how each device reaches the
  computer (*anywhere*, *anywhere with Tailscale*, *Wi-Fi link*), and a
  Wi-Fi link gets one line with **Show the code** to pair it once more
  through the relay. On the phone, a strip says: "This link works only on
  your home Wi-Fi. To use Caprock anywhere: in the Caprock app on your
  computer, Settings → Use on your phone → Show a code, and scan it."
- **phone:** the pairing steps on the phone's own page no longer send you to
  "Settings → Phone → From anywhere → Turn on", which does not exist; they
  name the Caprock app on your computer and Settings → Use on your phone.
  The refusals a phone gets (not paired, view only) say the same path.

## [0.116.1] - 2026-10-14

### Changed

- **now:** an opened Live pulse row is calmer and says more. Terminal,
  Open repo and Open session are quiet links at the end of the project's
  line instead of a row of bright buttons, and the empty space beside each
  live session now shows its cost, its last hour, how long it has run, its
  context, its branch with lines added and removed, and its pull request
  with CI. The legend can be hidden; the **?** in the panel's header brings
  it back.
- **app:** closing the tab of an agent Caprock started now asks: **Close
  tab** (in focus, so ⌘W then Enter works as before and the agent keeps
  running) or **Close and end the agent**, which stops it (asking once
  more if it is still answering; the conversation is kept). Tick *Don't
  ask again* to keep your answer; Settings → *Closing a tab* changes it
  back. An agent you started in your own terminal is never ended from
  Caprock: its tab just closes.
- **app:** in the Tabs list, sessions running with no tab sit under a
  quiet *Running, no tab* line, so an agent whose tab you closed no
  longer looks like an open chat.
- **app:** the sidebar's heading has a worded switch, **Projects | Tabs**,
  in place of the small folder icon: Projects lists the sessions under
  their projects, Tabs in one list in the tabs' order. Settings →
  Appearance → *Sidebar* uses the same words.

### Fixed

- **app:** updating no longer moves you off the sidebar you had. 0.116.0
  switched everyone who had never touched the sidebar toggle to the flat
  list; if you used Caprock before and never chose, the sidebar lists the
  sessions under their projects again. A first visit still starts on the
  flat list.
- **agents:** a permission prompt you answered from a button no longer
  comes back if the daemon crashes a moment later. The answer cleared the
  stored prompt in the background, so a crash before that write landed
  restored buttons for a dialog already answered; the answer now returns
  only once the stored prompt is gone.
- **cockpit:** the spend chart no longer jumps when you hover it. At rest
  the line above the bars stood 23px tall (the ▾ that picks the metric took
  the panel's larger font) and under the pointer 19px, so the bars and
  everything below them moved 4px on every hover; the line is now a fixed
  18px either way.

## [0.116.0] - 2026-10-14

### Added

- **deck:** the PRs & CI tab opens on a **Board**: the repository's pull
  requests as cards in six columns — Draft, CI running, Needs a fix, Ready,
  Merged, Released — each with its author's face and name, how long it has
  sat in that column, its CI, the agents on it now and its agent cost (what
  Caprock recorded agents spending on it, at API list price). Above it, the
  flow: merges a day, opened → merged, merged → released (an estimate), the
  CI median. Below it, each recent release with the pull requests it shipped
  and what the agents spent on them. A card opens the pull request in the
  List, the old view.
- **now:** a **CI/CD** section under Repos: GitHub's own status, and per
  repository the Actions minutes billed this month, CI time and its trend,
  red runs, runs stuck past their usual time or waiting for a runner, the
  newest release, the five pull requests the agents spent most on this week
  and who opened them. Folded, it reads nothing. With GitHub connected it
  also reads githubstatus.com and shows avatars from
  avatars.githubusercontent.com, neither sent your token; Settings → GitHub
  says so.
- **now:** two live sessions in one checkout are pointed out. When two
  sessions work in the same folder of a repository (not in separate
  worktrees), each Live pulse row gets a small chip naming the other; when
  both edited the same files in the last 30 minutes it turns amber, *2 files
  touched by both*, with the files on hover, since one can write over the
  other's change. *Move to a worktree…* beside it opens the New session
  dialog on a new copy of the folder, named after the newer session; nothing
  is moved for you. The agent cockpit shows the same chip, one line under the
  loop warning. New read-only `GET /v1/overlap`.

- **mail:** Mail no longer opens on a bare form. The first screen offers three
  ways in: *Try it with sample mail* (two made-up inboxes on servers inside
  Caprock, with a slim *Sample mail — nothing here is real* line to leave or
  to add your own account; your real mail and keychain are never touched),
  *Import my accounts* from Apple Mail or Thunderbird, ticked one by one, with
  a password field where none was saved and the Full Disk Access steps when
  macOS hides one, and *Add an account* as provider tiles — Google, iCloud,
  Outlook, Yahoo, Fastmail, Other. Google and Outlook sign in through the
  browser when this build offers it; otherwise, and always for iCloud, the
  form carries that provider's app-password steps and link. Settings' *Add
  account* uses the same tiles, and opening the Mail screen no longer creates
  an empty mail database.
- **app:** Claude's little character comes in eight faces — the hard hat,
  a beanie, headphones, a crown, a wizard's hat, a tuft of hair, a bandana
  and a propeller cap, each in its own pastel and expression. Each session
  gets one at random from its id and keeps it everywhere it shows; click
  the portrait in the cockpit to give a session another, and pick the
  default — a face per session or one for all — in Settings → Appearance.
  Kept in this browser only.
- **app:** the cockpit's state line and permission mode sit under the
  agent's portrait, so the figures at the right get the row; *started*
  moves under the model. The subagent chips come in groups of five and wrap
  onto a second line instead of being cut; past two lines they shrink to
  small squares, and past that a *+N* says how many more.
- **mail:** when you first open Mail it offers the accounts you already have in
  another client, so you add them with a click instead of retyping servers and
  passwords. Thunderbird comes over whole — servers and, when there is no
  primary password, the passwords too, decrypted on your machine (nothing is
  sent anywhere and no password ever crosses the dashboard connection). Apple
  Mail brings its server settings; its passwords are not readable, so you type
  each once, and on macOS without Full Disk Access Caprock says so and how to
  grant it. Each account is signed in to and verified before it is saved, and
  one account that fails never stops the others.
- **remote:** a phone reaches Caprock from anywhere — mobile data, another
  Wi-Fi — with nothing to install, through a relay that carries only
  end-to-end ciphertext (ADR-058). Settings → *Open Caprock on your phone* →
  *From anywhere*, or `caprock remote on`; it stays on across restarts. The
  machine dials out to the relay and proves its id with its Ed25519 key; the
  phone pins the machine's X25519 key from the QR and runs Noise NK with it,
  so the relay forwards bytes it cannot read or change. Pairing, device
  tokens and the viewer and controller roles are the LAN's own.
- **remote:** the phone's page (`ui`, `vite build --mode remote`) keeps
  several machines and switches between them from a strip along the top that
  says whether the machine is reachable; *+ Add a machine* takes a pasted
  pairing link, for an iPhone home-screen app.
- **cli:** `caprock remote [on|off|reset]`, `caprock pair`, which draws the
  pairing QR in the terminal, and `caprock remote relay`, a relay of your
  own. `relay/` is the hosted relay, a Cloudflare Worker with one Durable
  Object per machine.

- **mail:** adding an account finds the servers for about 40 mail services
  and the hosts people put their own domain on. The table now knows Yahoo,
  AOL, AT&T, Verizon, Cox, Xfinity, GMX, WEB.DE, mail.com, Zoho, Mail.ru,
  Rambler, Seznam, Daum, Orange, Free, SFR, La Poste, T-Online, Libero,
  Virgilio, mailbox.org, Posteo, Purelymail, Runbox, Mailfence and Migadu as
  well as Gmail, iCloud, Outlook, Fastmail, Yandex and Proton Bridge, each with
  what it needs (an app password, IMAP switched on) and its help page. A
  custom domain is recognised by its MX on Google Workspace, Microsoft 365,
  iCloud+, Zoho, Rackspace, GoDaddy, Namecheap Private Email, Spacemail,
  IONOS, OVHcloud, Hostinger, Titan, Infomaniak and STRATO. Any other domain
  is asked for its RFC 6186 SRV records and its own autoconfig file before
  Caprock falls back to `imap.` and `smtp.`; only the domain itself is asked,
  no directory. The answer says how it was found (`source`).
- **mail:** sign in with Google or Microsoft. A Gmail, Google Workspace,
  Outlook.com or Microsoft 365 mailbox connects with a click and an approval
  in the browser, no app password: the installed-app OAuth flow with PKCE,
  back to Caprock on loopback, then IMAP and SMTP over XOAUTH2. The refresh
  token is kept in the keychain like a password; a revoked or expired sign-in
  shows as a sync error asking to sign in again. Signing in with an address
  Mail already has switches that account over and keeps its mail. Nothing is
  sent to Google or Microsoft until the button is clicked. The buttons need
  the build's client IDs (`docs/mail-oauth.md`); iCloud keeps app-specific
  passwords, having no OAuth for mail.
- **doctor:** an Orphans section lists the processes on the machine that look
  abandoned, each with why: another Caprock daemon (and whether its data
  directory still exists), terminal holders no Caprock will reattach to from
  any install, a `claude` whose session ended or whose parent exited, MCP
  servers whose `claude` is gone, and what a Claude Code session started that
  outlived it. Anything in a terminal you are in, in a live session, of
  another user or inside an app is never listed. The list is taken when you
  open the doctor or run `caprock doctor`; the 10-minute sweep keeps a count
  for the status bar.
- **doctor:** an Advanced mode (off by default, on the computer only) adds a
  Stop to each orphan and *Stop selected*, each confirmed once more; `caprock
  doctor --stop <pid>` does the same from a terminal and asks first (`--yes`
  skips). The process gets SIGTERM, then SIGKILL after 5 seconds, and only if
  it is still the one listed — same pid, same start time. Caprock never stops
  a process it did not start on its own (ADR-059).

- **phone:** *Keep on after Caprock restarts* in Settings → *Use on your
  phone*: phone access comes back on by itself after an update or a reboot.
  Off by default; Turn off clears it; only paired phones get in either way
  (ADR-060).

### Changed

- **app:** the two dots at the start of every tab are gone. A tab shows
  state only when it needs you: an amber edge along its top while its
  session waits on you, a red one when it failed; working and idle show
  nothing. The project is its short name after the title, in its colour,
  and the Flat sidebar's rows follow the same rule.
- **cockpit:** the context and the plan limits are back near the top, right
  under *Now* and above the spend, and each has two looks. Compact, the
  default, is one line: *62% · 124.0k / 200.0k* with a thin bar, and *5h 41% ·
  05:40  Week 24% · Mon 13:00* with a tiny bar per window, the reset times
  cut first in a narrow panel. Click *Context* or *Plan* for the full view
  as it was — the meter, what each call re-reads, the plan and each window's
  bar and forecast. The choice is remembered on this device.
- **perf(store):** the cockpit's subagent rows and the Cost screen's
  summary read far less of the database. A refresh of a busy session's
  subagent rows took 25–37 ms instead of 224–303 ms on a copy of a 2.4 GB
  database, and today's per-turn attribution 42–59 ms instead of 69–79 ms;
  the burn tile no longer counts a whole summary of the last ten minutes on
  every request. A new migration builds three small indexes once, a few
  seconds on a large database.
- **phone:** the phone panel says first where it works — *Works on this
  Wi-Fi only* or *Works anywhere (Tailscale)* — instead of folding it under
  *Then: …*. Without Tailscale it names the one step (Tailscale on this
  computer and the phone, same account) with the downloads; it notices
  Tailscale by itself while open, listens on its address without turning
  access off and on, and a new code opens the Tailscale address. A paired
  computer is no longer counted as a phone: *No phone paired yet* says so.
- **remote:** the phone's first screen says what to do in three large steps,
  keeps the pasted link for a home-screen app behind one tap (shown at once
  when opened from the home screen), and answers the questions a careful
  person asks — is it safe, what the relay sees, why not an app, a lost
  phone, a relay of your own — with links to how it works and the relay's
  source.

- **app:** a new icon — a bold white C on a near-black tile, with a green dot
  in its mouth for a session running. The amber triangle got lost among its
  Dock neighbours; a letter reads at a glance. The menu-bar icon, the
  dashboard's favicon and the phone's home-screen icon carry the same mark.

- **cockpit:** subagent rows stay where they are. They stand in the order the
  subagents started, first on top, a new one added at the bottom; working,
  waiting, getting busier or finishing no longer moves a row, and a finished
  one stays in its place, dimmed with a ✓. What a subagent is doing now gets
  the row's whole width and two lines, the full text on hover; its figures
  moved to the line below, and *Show* in the Subagents header picks which of
  them each row carries — *Compact* (just the phrase), *Cost* (cost and time,
  the default) or *Full* (calls, cost, model and time), or any mix —
  remembered on this device.
- **app:** tabs are the way around. ⌘1–⌘9 (Ctrl+Shift+1–9 on Windows and
  Linux) switch to the Nth tab, and the tabs stay in the order you opened
  them: a new tab goes last with the next number, and the numbers change
  only when you close or drag a tab; a restart keeps them. Every tab shows
  its key, the one in front too, and its session's name with its project's
  dot and short name. The sidebar is Flat by default — the open sessions in
  the tabs' order, each with the same key and its project, then the ones
  running without a tab — or Tree, sessions under their projects (Settings
  → Appearance, or the folder button). Projects have no number keys any
  more; a click on a project opens its page, and ⌥⌘ arrows still walk
  sessions and projects. The pinned Dashboard tab shows ⌘0 again (⌘, on
  Settings) and the inspector's button ⌘I, so every key is on screen. One
  line says so once, with a way to every key.
- **deck:** a pull request's checks read at a glance. In place of a circle per
  check — twelve tiny circles in a row that said nothing — each row sums them
  up in one short group: *✗ 1 failed ● 1 running ✓ 10*, the failed first, the
  running one pulsing, skipped ones a dim count only when there are any, and a
  finished green PR just *✓ all 12 · 6m*. Hovering it lists every check with
  its OS, state, time and the step a failed one stopped at; a click opens that
  job. The circles-or-words switch is gone, a row no longer says *$0* for a
  public repository's free runners, and the cockpit's CI block uses the same
  summary, its view tabs now named *PRs · Ring · OS*.
- **deck:** Expand is a button you can see — outlined, with its key, ⇧⌘B
  (Ctrl+Alt+Shift+B on Windows and Linux) — and in the PRs & CI tab the same
  button in the same corner reads *Collapse* and takes you back to the agent
  with its deck; the key toggles both ways. *Back to the deck* is gone. A
  pull request's title gets every pixel its row's checks leave, a step
  larger, cut only when the row is full. The circle per check is back as the
  default, with the summary one click away (*Checks: circles | summary*,
  remembered); hovering the circles shows the same card of every check.
- **settings:** every saved credential (DeepSeek key, Telegram bot token, a
  pasted GitHub token) is entered in one secure field: a lock inside, masked
  monospace text, an eye only while typing, and once saved a locked pill with
  its hint and where it is kept, with Replace and Remove. An (i) explains
  where it is stored, what it is sent to, how backups treat it and how to
  revoke it at the provider. Settings says under each field whether it is in
  the macOS login keychain or in a file, with the file's path.

### Fixed

- **now:** Live pulse rows stay where they are. They were sorted by the
  newest event, so two busy sessions swapped places every few seconds; now a
  row keeps the order its session started in (sessions open as tabs follow
  the tab strip among themselves), a new one lands last, and you can drag a
  row, or press ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift on Windows and Linux) on it, to set the
  order, remembered in this browser. Each row now leads with the session's
  name in bold, with the project, branch and short id under it, so two
  sessions on the same branch can be told apart.

- **app:** switching tabs no longer redraws the terminal's font for a moment. A tab hidden for 30 s had let its WebGL renderer go, so it came back drawn by the DOM renderer, in other glyphs and another cell height, until WebGL was swapped in 1.5 s later; a tab hidden for less had its glyph atlas rebuilt on every switch. The three tabs hidden last now keep their renderer, a tab past that gets it back before it is first painted, and the atlas is rebuilt only after a wake, a pixel-ratio change or a hide of more than five minutes, so the squashed letters of #541 stay fixed.
- **app:** the version panel in the status bar has a close button; Esc
  and a click outside still close it.
- **app:** a button's tooltip no longer covers the panel it opened: the
  Caprock doctor, the version, the theme picker and the composer's menus
  show their tooltip only while closed.
- **app:** a session no longer jumps into Claude Code's background-agents list on its own. Holding ⌥⌘↓ (Alt+Shift+↓ off macOS) to step through sessions and letting go of the modifiers before the arrow left the arrow repeating into the session it had just opened, and Claude Code read that Down as "go to the agents below the prompt". An arrow pressed as an app chord now stays the app's until it is released, and the sidebar's ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift+↑ ↓ off macOS), which typed a Down too when pressed in a terminal, do nothing there. Plain arrows and ⌥← ⌥→ word jumps are unchanged.
- **app:** the desktop app no longer opens to a black window when the deck's
  CI panel was left on Release and the newest release run lists no jobs. The
  daemon sent that run's jobs as `null` instead of an empty list; it now sends
  `[]`, and the dashboard reads a missing list as empty, cached answers
  included.
- **app:** a screen that fails to draw no longer blanks the window. The deck
  fails on its own and the terminal stays; a failure anywhere else shows
  *Caprock hit a snag* with Reload, *Reset the view and reload* (forgets cached
  figures and the CI panel's view, keeps tabs and settings), and a report the
  user sends themselves: a prefilled GitHub issue, an email or the details
  copied. The report holds the error, where it was thrown, the version and the
  OS; a home directory is folded to `~`, and nothing is sent by Caprock.
- **app:** scrolling up a terminal no longer shows Claude Code's prompt
  rules and status rows smeared and repeated across the history. A tab
  restored behind another parsed its replay at xterm's default 80 columns,
  and told the daemon that size, before it had ever been laid out; it now
  holds the replay and sends no size until it is shown and fitted.

- **mail:** on macOS, account passwords go to the login keychain through the call that names the keychain file, so saving one can never bring up a "Keychain Not Found" dialog. Passwords saved before are read where they are; Windows and Linux are unchanged.
- **daemon:** a session with no process behind it ends as soon as its transcript file or its folder is deleted, instead of staying in the sidebar for 24 hours. Nine synthetic transcripts a test script wrote and removed left nine such sessions listed as "working". A session is also no longer shown as working because of an event stamped ahead of the clock.
- **mail:** a wrong password on Spacemail and other Dovecot hosts says so. They answer it with "NO [UNAVAILABLE] Temporary authentication failure", which read like an outage; the error now says the password was not accepted, and the other sign-in names are not tried, since more failures only lock sign-in longer.

### Security

- **settings:** the DeepSeek API key and the Telegram bot token are no
  longer kept in `config.json`. They live where the GitHub token does: the
  macOS login keychain, or a file only your user can read in the data
  directory on Windows and Linux (or when the keychain refuses). A key an
  older release wrote to `config.json` is moved there on the daemon's next
  start and removed from the file. A DeepSeek session reads its key from
  there when it starts, into its own environment only.

## [0.115.1] - 2026-10-13

### Fixed

- **mail:** iCloud and Gmail accounts connect the first time. The sign-in
  name is retried in the forms iCloud accepts (the full address or the part
  before the @; for sending, the @icloud.com address), an iCloud+ custom
  domain is recognised and asks for the @icloud.com sign-in, and a refused
  password says which app password to make. Mail is read from each message's
  whole header, so iCloud's malformed answers no longer stop a folder, and one
  message the server cannot describe is kept and shown instead of halting sync.
- **app:** a terminal no longer shows squashed, half-cut letters after the
  Mac sleeps, the window moves to another display or the tab comes back from
  a long spell hidden. WebKit can drop the WebGL glyph atlas without saying
  so; the terminal now rasterises its glyphs again whenever it is seen again
  and whenever the pixel ratio changes.

## [0.115.0] - 2026-10-13

### Added

- **phone:** a home for the phone. Caprock on a phone — on its home screen
  above all — opens on what waits on you (answer a permission prompt there),
  the sessions to continue and what you saved, with one field docked at the
  bottom: pick a project and an agent, type, **Start chat**, and the chat
  opens; or **Save** a note, a link or photos for later. *New chat* also
  picks what it runs on, DeepSeek included. The full dashboard is one link
  down (`#/now`), and the dashboard's header gives way to one bar — Caprock,
  its connection state and a ⋯ menu. A one-time hint says how to add Caprock to the Home
  Screen. The manifest declares *New chat* and *Save* shortcuts and a share
  target; they need Caprock served over `https` and do nothing yet.
- **app:** what the phone saves shows on the Mac in Quick chat under
  *Saved*: start a chat from one (its text and photos become the first
  message, in its project when it has one) or delete it.
- **daemon:** the Inbox — `GET`/`POST /v1/inbox`, `DELETE /v1/inbox/{id}`,
  image thumbnails at `/v1/inbox/{id}/files/{n}` and an `inbox` live frame
  (migration 0053). A phone you let control saves and deletes; any paired
  phone reads.
- **app:** rename a session from its tab or its sidebar row: double-click
  the name, or right-click the row for *Rename…*; Enter or clicking away
  saves, Esc keeps the old name, an empty name gives back the one Caprock
  made. The new name shows at once in the tab and the sidebar, in every
  window, and stays after a restart (`PUT /v1/sessions/{id}/name`,
  migration 0052). A session you have not named is called by the agent's
  own title, or else by a few words of your first message (*Fix the login
  bug*) rather than the whole sentence.
- **mail:** Caprock Mail, a mail client inside Caprock. Every IMAP account —
  Gmail, iCloud, Fastmail, a company server — in one inbox at *Mail* (last in
  the dashboard's screen row, marked *new*): conversations, instant search
  over mail kept on this computer, archive, delete, spam, star, folders,
  compose, reply, forward and attachments, new mail at once over IMAP IDLE,
  and a keyboard for all of it. HTML mail never runs scripts or loads
  trackers until you allow images. Optional summaries and reply drafts from
  a model on your own computer (Ollama, LM Studio). Off until you add an
  account; it then talks only to the mail servers you entered, passwords in
  the system keychain. A one-time strip offers it after two days of use.
- **app:** move between projects and their sessions from the keyboard.
  ⌘1–⌘9 bring a project to the front by its place in the sidebar (⌘9 the
  last), its key drawn on its row and on the tab it brings; ⌥⌘↓ / ⌥⌘↑ go to
  the next / previous session of that project, ⌥⌘→ / ⌥⌘← to the next /
  previous project, both round the end. On Windows and Linux they are
  Ctrl+Shift+digit and Alt+Shift+arrows (Ctrl+Shift+← → stay PowerShell's
  select-by-word). Option+← → stay word jumps in the
  terminal and ⌘↑ ↓ stay the terminal's; in a text field the arrow chords
  keep selecting there. The project in front has a faint edge in the
  sidebar, so you see where you are among the others.
- **app:** *Group by project*, a folder toggle beside the sidebar's
  heading: off, the sidebar is one list of every agent session in a kept
  order, each row with its project's colour dot and short name, and ⌘1–⌘9
  pick sessions instead of projects. The app remembers the choice.
- **app:** drag a session row under a project onto another to put it
  there, or focus it and press ⌥⇧↑ / ⌥⇧↓ (Ctrl+Shift off macOS); the order
  is kept for that project, also after a restart.
- **app:** the cockpit has a **CI** block: the session's pull requests as
  a circle per check, one ring with *10/11 · 5m* and the time against the
  median, or the current PR's jobs by OS — switched in its label, kept per
  viewer. It draws only what the session deck already read and asks
  nothing; a click opens the PRs & CI tab.
- **app:** a **Repos** table on Now, under Live pulse: a row per repository
  with a session running in it — commits a day over 14 days, today's and
  the week's, lines added and removed, files not committed and the last
  commit, from the repository's own git (read at most every 10 minutes);
  and, while GitHub is connected, open pull requests, red runs with the
  median CI time and the newest release, only from what the session deck
  and its PRs & CI tab already read — the table asks GitHub nothing. Folds
  like the other panels, remembered per viewer; folded, it asks nothing.
- **api:** `GET /v1/repos/activity`, the Repos table's rows.
- **app:** the cockpit's spend chart can show **burn rate** — each bar the
  stretch's cost over the hours actually worked in it (hours with five or
  more calls), so an idle afternoon does not water it down and a stretch
  with none has no bar rather than $0/h — next to cost, tokens and turns.
  A faint dashed **pace line** marks your usual (for burn rate, your
  30-day cost per active hour) or the period's average stretch, labelled at its right end (*usual $3.00/h*); bars above it
  stand stronger, amber only in your top fifth, and hovering a bar says
  *38% above your usual*. The choice is remembered, and the folded strip
  follows it. Each project's `spark` in `GET /v1/stats/summary` carries
  `active_hours` and `active_cost` from the same scan, and each of
  `usual`'s distributions its `mean`.

### Changed

- **app:** rows under a project keep their places. Picking a session from
  the sidebar, opening it as a tab or bringing it to the front no longer
  moves it up: rows go in the order you set by hand, then in the order the
  sessions started, and a new one lands last.
- **app:** under each project the sidebar lists every agent session —
  working, waiting or idle — and nothing hides behind a *+N more* line.
  Shells and open files have no rows (they are in the tab strip), an ended
  session drops off, and rows are 28 pixels with no agent mark (the agent
  is in the tooltip).
- **app:** one quiet *More…* row at the end of the sidebar replaces the
  *More projects* and *Hidden* folds: it lists the other projects (click
  to open) and the hidden projects and session rows (click to show again).
- **app:** ⌘1–⌘9 now pick the sidebar's Nth item rather than a tab by its
  place in the strip, and the strip follows the sidebar's order, so the
  numbers on the left and on top agree; only the tab ⌘N brings shows its
  digit. ⌃Tab and ⇧⌘[ ] still cycle the tabs.
- **app:** tabs are named by their session again, so four or six tabs all
  keep their names: the project is the coloured dot (and in the tooltip
  with the agent and the branch), the agent mark is gone from the tab, the
  dots sit closer, and the ⌘ key is a small key at the right end that the
  × replaces on hover and on the tab in front. The Dashboard tab is its
  icon alone, its key in the tooltip.
- **app:** the session deck opens on all of the session's pull requests:
  no row opens by itself, and the one you open is opened again next time.
  Each row shows a circle per check again — filled, coloured by state, a
  running one pulsing — at every deck width, with a switch to the words
  (*running · 10/11*), kept per viewer.
- **api:** the first `GET /v1/sessions/{id}/prs` of a session whose
  composition has to wait on GitHub answers at once with the recorded pull
  requests, without their CI, marked `refreshing`; the next poll has them
  with it. The deck draws the rows straight away.
- **ui:** Dark Pastel is the default dark palette (owner, 2026-10-13), and
  first among the dark ones in the picker and the cycle; Book stays the
  default light one. Whoever never picked a palette — a new install, the
  phone, the menu bar popover, the app's start-up page — now sees Dark
  Pastel on a dark system, from the first paint. A palette you picked is
  kept, Dark Warm included, and an old Slate stays Dark Cold; the old
  Graphite tone was the default rather than a choice, so it moves to Dark
  Pastel. The home-screen colours and the screenshot scripts' dark pass
  follow.

### Fixed

- **app:** Settings → phone and Telegram are where the sidebar says. The
  words *phone* and *Telegram* beside Settings are links, each opening its
  section unfolded and scrolled into view; *phone* also shows the pairing
  QR at once, and the Settings row itself opens on the phone. *Use on your
  phone* (the QR, three steps — same Wi-Fi or Tailscale, scan the code, Add
  to Home Screen — and your paired phones) and Telegram now come first in
  Settings; `#/settings/phone` and `#/settings/telegram` link straight to
  them.

## [0.114.0] - 2026-10-13

### Added

- **app:** the session deck's pull requests and CI, large. **Expand** beside
  *Hide ⌘B* opens a *PRs & CI* tab: the repository's last 14 days on top —
  pull requests merged per day, the median time to merge, the median CI run
  of its slowest workflow, the share of red runs with re-runs, and the
  Actions minutes GitHub billed this month — its pull requests on the left
  (this session's, the repository's newest 50, or the open ones), and the
  chosen one on the right: state, CI, merge state and review as large
  pills, the diff's size, the deck's Fix / Re-run / Update actions, its jobs
  as a grid of job × runner OS against each job's median, the jobs on the
  run's clock, and a failed job's steps and log with *Investigate*. *Back to
  the deck* returns to the agent. It asks GitHub only while it is the tab in
  front, through the deck's kept answers, plus one list of the repository's
  newest 100 runs kept 30 minutes; nothing at all while GitHub is not
  connected. No new key and no sidebar item.
- **api:** `GET /v1/sessions/{id}/ci/stats` (the tab's figures and the
  repository's pull requests); a pull request carries `created_at`,
  `merged_at` and its diff size (`additions`, `deletions`,
  `changed_files`, `commits`); `…/ci?pr=N` and the rerun and update-branch
  routes also take a pull request of the repository that the tab listed.
- **app:** Settings → *Status line* → *Hidden*: no line under Claude Code, so the
  row goes, while your plan limits keep reaching Caprock's cockpit and Cost
  screen — which *Off* stops. Recommended on the page, never chosen for
  you; Full stays the default.
- **app:** the cockpit's headline says how it compares with your own usual —
  *▲ 38%*, *≈ usual*, *▼ 55%*, *▲ 4.5×* left of *burn rate ▾* — against
  your median active session-hour (burn rate), your median session (cost,
  tokens) or your 30-day hit rate (cache, in points), all measured on this
  machine over the last 30 days. Amber only in your top fifth; hover says
  it in full; nothing at all until there is enough history. The new
  `usual` on `GET /v1/stats/summary` carries the baseline.
- **app:** the cockpit's spend chart switches what its bars measure —
  cost, tokens or turns — from a *cost ▾* after its total, in the hero's own
  menu style and remembered per viewer. Hovering a bar reads its figure in
  that metric's own format (*$12.40*, *950.1k*, *1,204*).
- **daemon:** each project's `spark` in `GET /v1/stats/summary` carries two
  more arrays over the same buckets, `input` (input tokens with cache reads
  and writes) and `turns`, from the same scan as `cost`, so the chart can
  plot today, 7 or 30 days by tokens or turns without another request.
- **agents:** Claude Code on DeepSeek, free. Paste your DeepSeek API key in
  Settings → Subscriptions and *New agent* and *Quick chat* offer
  **DeepSeek · your API key** in the Subscription picker: the session is
  Claude Code in your usual setup, with DeepSeek's documented variables and
  your key in that one process's environment, so its model calls go to
  DeepSeek's Anthropic-compatible API and DeepSeek bills your key. Your
  claude.ai sign-in and its plan limits are not used, and the session is
  kept out of the Claude plan windows and the plan-window stop. The key is
  write-only (Settings shows `sk-…1a2b`), never on a command line, in the
  database or a log; Settings and the picker say what the session sends to
  api.deepseek.com and that Caprock sends nothing. Its card says
  *DeepSeek*.
- **app:** each subagent row in the cockpit says what the subagent is doing
  now in words — the description Claude wrote for its latest command
  ("Rerun the store tests"), else its tool and target ("Editing
  Cockpit.tsx"), else its task — after its type as a letter chip (G, E, P,
  the full type on hover), with calls and cost beside it; the dimmer line
  under it shows the raw command only when the phrase does not already say
  it. `GET /v1/sessions/{id}/subagents` carries the phrase as `doing` and
  `doing_from`.

### Changed

- **dashboard:** the Now screen refreshes once, not once per section. Its
  sections ask on one shared tick, at most every 2 s (all-time figures every
  10 s); sections asking the same question share one request; a folded or
  scrolled-away section asks nothing until it is seen again; and the live
  pulse and activity feed no longer read every track's history again each
  time two busy sessions swap places. Under a steady stream of hook events
  (five sessions, ten events a second) the open screen went from about 650–770
  requests a minute to about 100, and the daemon's CPU for it on a copy of a
  2.2 GB database from 36 s to 17 s per minute (measured 2026-10-13). A screen
  opened after events had arrived no longer asks every question twice.
- **app:** the hot-process flame on a sidebar row or tab draws again only
  when what it says changes: every row's mark redrew on each 5 s resources
  sample, hot or not. It stays a static mark — no animation to pause.
- **daemon:** the database gets smaller on its own. While Caprock is idle
  (nothing recorded for 30 minutes) it replaces the screenshots and files
  that events stored before 0.113.0 still hold as base64 with the marker new
  events get, *[image image/png 512 KB not stored]*, a few hundred events at
  a time; the text of every event is kept whole. It then compacts the
  database once — only with free disk of about twice its size, rolled back
  unchanged if anything is recorded meanwhile — and from then on gives free
  space back to the disk as it appears, including what a retention period
  deletes. New databases do that from the start. On a copy of a 2.2 GB
  database (2026-10-13): 4,181 events rewritten, 750 MB of payload removed in
  79 s, compaction to 1.4 GB in 21 s; a writer committing every 20 ms
  throughout never failed. `caprock doctor` lists each step under *done on
  its own*; the Storage panel no longer tells you to stop Caprock and run
  VACUUM, and `GET /v1/storage` carries `returns_free_space`.
- **app:** the sidebar lists only active sessions under a project: what is
  working, looping or waiting on you, plus the tab in front so it always
  has its row. Idle sessions, rows you hid, files and quiet shells sit
  behind one faint *+N more* (its tooltip says what it holds, hidden rows
  included); opened, the hidden ones come last with an eye to show them
  again. The separate *N hidden · show* line is gone, *+N more* no longer
  stays open across restarts, and a project with nothing active is just
  its own line, its arrow listing what is in it.
- **app:** Spend moves up in the cockpit, from after the plan windows to
  directly under *Now*. Folded, it is a strip of the chart's own bars and
  three figures, the chart's metric first, instead of a faint sentence a
  narrow cockpit cut off.
- **pricing:** `deepseek-flash` at DeepSeek's off-peak list price ($0.15
  input, $0.003 cache hit, $0.60 output per 1M, read 2026-10-13); turns in
  DeepSeek's weekday peak hours bill double and read low. Table
  `2026-10-13.1`.

## [0.113.0] - 2026-10-13

### Added

- **cli:** `caprock doctor` says what Caprock costs this machine — memory and
  CPU of the daemon, the app, the app's window and the terminal holders; the
  data directory split into database, pastes, logs and binaries; the
  daemon's disk reads and writes over the last minute and hour — flags a
  second daemon, a second app, orphaned terminals, a database over 2 GB and
  heavy disk reads, and exits 1 when something is flagged. `--json` prints
  the new `GET /v1/footprint`. It works with no daemon running.
- **app:** what Caprock costs this computer, one click from the status bar.
  *caprock 1.1 GB · 2.2 GB* at its right is the memory of every Caprock
  process and the data directory on disk (memory alone in a narrow window),
  in the warning colour with a dot when something is flagged. A click — or
  the palette's *Caprock doctor* — opens the doctor as a panel: the verdict
  in one line, each warning with the processes behind it, what the memory
  and the disk are spent on, the daemon's disk reads and writes, what it
  cleaned up on its own, **Check now**, **Stop N orphans** and **Copy
  report**, which copies exactly what `caprock doctor` prints.
- **daemon:** the resource meter counts the app's window: on macOS the
  WebKit helpers that draw it (hundreds of MB that belonged to no one
  before), elsewhere the app's child processes.
- **daemon:** any database statement slower than 300 ms is logged with the
  code that ran it, so a slow screen or a burst of disk reads names its cause.

### Changed

- **daemon:** one daemon per data directory. A second one waits 5 s for a
  restarting one, then exits naming the pid of the one that runs.
- **daemon:** the automatic orphan sweep runs every 10 minutes and stops
  every orphaned terminal holding only an idle shell, whichever Caprock
  started it — eleven left by deleted preview stands survived every hourly
  sweep before. A write-ahead log over 256 MB is checkpointed on its own.
  Both are listed in the footprint's `actions` with their time.
- **app:** the cockpit's figures beside the agent open on burn rate, big,
  with tokens and cost under it — what a session is doing now first, what it
  has added up to under it. A choice someone made stays; one that was only
  ever the old cost-first default takes the new one.
- **app:** a hidden window does no work, and an idle one almost none. Out of
  sight (minimized, closed or covered), the page stops its polls and clocks,
  holds live events and applies them together every 2 s (at once for a
  notification, a permission prompt or a loop alert, and the moment the
  window is shown), pauses animations, and the terminal in front neither
  draws nor blinks; the menu bar and Dock badge stay current. Shown, screens
  that follow agents at work redraw a batch at a time rather than per event,
  and clocks tick every second only while something on screen is under a
  minute old.
- **store:** tool calls are stored the way the screens read them. A hook's
  tool input and output now go through the same cap as the transcript's:
  screenshots and other base64 become a marker naming their type and size,
  text past 32 KB is clipped with a marker saying how much was dropped, and
  every short field — paths, commands, exit codes — stays. Tool sizes still
  count what the tool really returned. On a copy of one 2.2 GB database the
  same history needed 841 MB less.
- **daemon:** the database is read far less. The Storage figures are measured
  when the panel finds them a day old, or once a day while nothing is
  running, instead of a full read of the database every 30 minutes; a start
  no longer pre-computes the share dialog's 30-day and all-time Weeks; and
  the write-ahead log shrinks back to 64 MB after a big write.
- **daemon:** old leftovers are cleaned up on their own, once a day while
  idle: pasted and dropped files after 30 days, empty quick-chat folders no
  session used, Gemini telemetry of sessions ended over 30 days ago, and the
  unused `launchd.log`. Each sweep logs what it removed and how many bytes,
  and is listed in the footprint's `actions`.

### Fixed

- **deck:** the Pull requests & CI panel opens on what it last knew. Its
  PRs, Branches, Release and Main views draw the last list at once — when
  the deck opens, when the app starts, when you switch views — and read
  again behind it, with *updating…*, *updated 12 s ago* or *couldn't
  refresh* in the header; the very first read shows three grey rows rather
  than an empty area. The daemon keeps each composed answer too, so a
  request whose GitHub reads have expired is answered at once from the last
  one while one refresh runs behind it, instead of waiting seconds on
  GitHub. GitHub is asked no more often than before.
- **app:** the spend chart's hovered bar shows its own figure in full. While
  a bar is hovered (or stepped to with ←/→) its cost takes the big figure's
  place with a short date beside it (*$287.12 Sun 11 Oct · 06–12*, *of
  $1,299.44* at the right); leaving the chart puts the total back. In a
  330px cockpit the figure used to be the part cut off.
- **terminal:** a phone put away gives the PTY back at once. With a session
  open on the desktop and a phone, the desktop's terminal shrank to the
  phone's width and stayed so after the phone was locked or closed, until
  the session was reopened. A terminal going out of sight now says so and the
  daemon returns the PTY to the terminal still in sight, at its size; the
  desktop also re-sends its size whenever it is focused or shown, and
  focusing the composer counts as using the session.

## [0.112.4] - 2026-10-13

### Changed

- **app:** the cockpit puts the model on its own line under the agent's
  name, so a wide figure at the right no longer cuts it to *Opus …*; how
  many subagents work now leads their row (*3 working*).

## [0.112.3] - 2026-10-13

### Changed

- **app:** the cockpit's top block holds one calm layout in every state.
  The agent, its model and state on the left, the big figure fixed at the
  right of the same row, the permission mode and the two smaller figures
  under them, and one line of subagent chips at the bottom; working,
  waiting on you, idle or ended only changes the colours and the chips,
  never where anything sits. A long model name is cut with the full name on
  hover instead of wrapping, and the chips fit as many groups of four as the
  inspector is wide.

## [0.112.2] - 2026-10-13

### Added

- Settings → *Status line*: Full, Short or Off for the line Caprock puts at
  the bottom of Claude Code. Short is model, context and the plan windows
  (the reset time only from 80%), without the cost and counters the cockpit
  already shows; Off removes Caprock's own entry from Claude Code's
  settings, never one you set. Full stays the default.

### Fixed

- **app:** the cockpit's subagent row keeps its place: with none running it
  says *no subagents running*, so the agent's figures and the sections below
  no longer jump as subagents start and finish.
- **app:** on Windows, closing a shell tab no longer says it is running
  `csrss` (or another stranger) when it is at its prompt. A process whose
  parent exited long ago still names that parent's pid, and Windows reuses
  pids; a child now also has to have started after the shell.

## [0.112.1] - 2026-10-13

### Added

- **app:** finished copies clean themselves up, asking first by default. A
  copy Caprock made that is merged (or its pull request is), pushed, clean
  and has nothing running in it shows on the project's page and the deck's
  Branches view as *3 copies done · 2.1 GB · Clean up*; one click, confirmed
  on the same line, removes exactly those, and *Review* opens the copies
  list with them ticked. Settings → Worktrees: *Off*, *Ask* or *Auto*
  (removed a day after they finish). *Undo* for a day, branches kept 7 days
  with *Restore* under *Recently removed* in the copies list, and a *stale*
  tag for a copy with no commit in 14 days and no pull request. The main
  checkout, your own worktrees and unmerged branches are never touched.

### Changed

- **app:** a session started in another terminal opens in its own tab. A
  click on its sidebar row (or in ⌘K, the Inbox, a project's *Recent*) used
  to switch to the Dashboard tab on the session's page; it now opens a tab
  named after the session, with the agent's mark, showing its conversation
  live and read-only with the inspector beside it. Where the terminal would
  be, it says *Started in another terminal — Caprock watches it, it can't
  type into it*, with **Continue here** (a new process on a copy of the
  conversation, in a new tab; the original is never touched) and **Open in
  dashboard**. An ended session opens the same way, and Continue here
  carries it on in the same tab. The tab's ⋯ menu hides the session from the
  sidebar or closes the tab; a hidden session comes back only when it next
  needs you.

### Fixed

- **ui:** Lifetime's *Top projects* donut sits beside its table again instead
  of drawing over it; a donut without a legend keeps its own width.
- **app:** *Hide* on a project in the sidebar did nothing when an agent in
  it had finished its turn, or when it was the project in front — from the
  row's eye, its ⋯ menu and a right-click alike, *Outside projects*
  included. Hidden now wins: the project moves under *Hidden* (the one in
  front stays in view under that heading, its tabs open), and comes back
  out only when an agent there asks or finishes a turn after it was hidden.
- **deck:** every open pull request shows its actions. The ⋯ was a faint
  dot at the row's end that read as part of the age, and the actions only
  appeared once a row was opened, so they went unseen. Now the row's one
  problem carries a direct word beside it — *Fix* for a conflict, *Fix* and
  *Re-run* for failed CI, *Update* for a branch behind — that asks on the
  same line, and the ⋯ is a clear button at every width. Without GitHub
  connected the actions are there greyed, with *Connect GitHub*.
- **deck:** a pull request row says whether anything is on it in one word:
  *in work* (an agent on its branch working, or a re-run, update or fix
  Caprock started), *waiting* (an agent there asks you) or *queued* (a
  message queued for it, or GitHub's auto-merge on), with the agent's
  initial beside it. The row shows one problem chip, the most important,
  the rest in its tooltip, and at a narrow deck the mini pipeline goes
  before the title does.

## [0.112.0] - 2026-10-13

### Added

- **app:** an optional composer under an agent's terminal (Settings →
  Terminal, off by default): a highlighted box to write a message in, sent
  with Enter through the message queue so several lines arrive as one, with
  the `/` and `@` pickers, saved prompts, pasted images and ↑ ↓ history; it
  queues while the agent works and points at the terminal while the agent
  asks. Only for sessions Caprock started; with it off nothing changes.
- **ui:** a Dark Pastel theme: a neutral graphite ground, a dusty blue
  accent and soft, low-chroma status colours, with a terminal to match — for
  whoever finds the other dark themes loud. Body text stays at 7:1 or more,
  muted text and the accent at 4.5:1 or more.
- **deck:** pull requests show what stands in their way and who is on them,
  and can be fixed or re-checked from the row. An open PR carries one-word
  chips beside its pipeline — *conflict*, *behind*, *review* (changes
  requested), *draft* — from what GitHub already said, and nothing while
  GitHub is still computing. A live agent whose checkout is on the PR's
  branch shows as its initial with *fixing*, *waiting* or *idle* (*2
  agents* for several); a click opens its tab. The open row, or its ⋯,
  offers *Fix conflict with agent*, *Update branch*, *Fix CI with agent*
  and *Re-run checks*; each confirms in one line inside the row, then says
  what it is doing there (*agent fixing…*, *re-running 5 jobs…*,
  *updating branch…*) until GitHub shows it done. A fix goes to the
  Caprock-started agent on the branch, else a new agent starts in the
  branch's checkout or a new worktree at the PR's head; nothing is typed
  into a session Caprock did not start. Re-run and Update branch use
  GitHub's own APIs with your token, and a refusal names the permission
  the token is missing.
- **Make any subscription the default.** Settings → *Subscriptions* marks
  the one new sessions start on when you pick none, and every other one has
  *Make default*. Your own sign-in can be renamed and made the default
  again; nothing about `~/.claude` or its sign-in moves. The pickers in New
  agent, Quick chat and the phone's start form open on it.
- **A plan per subscription.** With more than one Claude Code sign-in,
  Settings → *Plan & licence* has a row per account with its own plan;
  one without a plan uses the main plan, your own sign-in's. A session's
  cockpit shows its account's plan and windows, and the plan chip there
  sets that account's plan (`PATCH /v1/subscriptions/{id}` takes
  `make_default` and `plan`).
- **Continue on another account.** A running session never changes account;
  the inspector now offers a new session on another one, with a brief of
  this one, and the session page's *Continue in…* lists each account. The
  cockpit and inspector name the account a session runs on, your own
  sign-in included once there is more than one.

### Changed

- **ui:** Dark Cold's blue accent is one step softer.
- **ui:** Settings → Projects calls its folder *Where you keep your code* and
  says what it does: Add project and Browse open there and a new session
  suggests the repositories inside it; it limits nothing, every folder you
  run an agent in or add is a project wherever it is.
- **ui:** the Memory screen opens with one paragraph saying what it is for:
  every answer Claude wrote you, searchable, linked to the moment it was
  written, and what a new session in the same folder is handed.
- **ci:** a pull request that does not touch the desktop app (`app/`, the
  `Makefile`, `ci.yml`) skips the three app builds, and the Go jobs no longer
  wait for the dashboard job. Go and Rust caches are written once per OS from
  `master` and read by every job. A release builds the app while `verify`
  runs, as two halves of `make check` side by side, and attaches it only after
  goreleaser has published, so a red `verify` still publishes nothing.
- **app:** each project in the sidebar shows one row: the tab you are on (or
  its last one), else what waits on you, else the agent that worked last.
  The rest fold behind one quiet *+N more* line that opens in place, stays
  open per project, lists what it holds in its tooltip (*2 working · 1 idle
  · 1 shell*) and turns amber when something behind it waits (*+4 more · 1
  asks*). It replaces the *Running in other terminals* line; ⌘1–⌘9 still
  reach every tab.
- **app:** three figures beside the agent in the cockpit, each one yours
  to pick: the headline in large type and two short lines under it
  (*$4.08/h burn ▾*, *4.01B tok ▾*), from one list — cost, burn rate,
  tokens, cache hit rate, turns, time working, last call, tool calls —
  never the same one twice (picking a taken one swaps them), cost, burn
  rate and tokens until you choose. In a narrow inspector the two lines
  move under the agent, beside the subagent chips, rather than squeezing
  the agent's own lines or being cut.
- **app:** the Spend block in the cockpit opens on its chart again,
  unfolded: the period's spend by time with its total and the stretch
  under the pointer. *Numbers* is still a click away on the *Chart |
  Numbers* switch. A choice saved while Numbers and folded were the
  default opens on the chart once; what you pick after that holds.

### Fixed

- **ui:** big figures never run into the next tile or lose their leading
  digits. A figure keeps its size while it fits and shrinks to its tile when
  it does not (*$130,489.86* beside a seven-figure burn rate, in a narrow
  window or the app with the sidebar open), and the caption under it wraps
  instead of being cut off.

## [0.111.3] - 2026-10-12

### Fixed

- **app:** the version panel's update button reads at a glance: *Update to
  v…* on one line, with *Restarts the app · sessions keep running* in small
  type under it, instead of one sentence wrapping across the button.
- **app:** the cockpit's headline figure stays on the agent's row, at its
  right, in a narrow inspector too: it shrinks there instead of dropping to
  the subagent chips' row.

## [0.111.2] - 2026-10-12

### Fixed

- **ui:** the At a glance donuts read in full on a 14-inch screen. The bill
  by token type is labelled *cache read*, *cache write*, *output* and
  *input*, the names used everywhere else, with *re-reading context* and
  *uncached* as a quiet second line; the donut centre's caption wraps onto
  two lines instead of ending in an ellipsis, on every donut in the app. A
  donut narrower than about 400px puts its legend under the chart at full
  width, and the three sit side by side only when the panel has room for
  them. Hovering a slice or a legend row, or focusing a row with the
  keyboard, lights that slice and shows its share, name and figure in the
  centre, in place, with no popup.

## [0.111.1] - 2026-10-12

### Changed

- **app:** the cockpit's Spend block shows numbers or a chart, your pick. Its
  header holds the period chip (*session · today · 7d · 30d*) and a small
  *Numbers | Chart* switch in place of 0.111.0's *Compact | Full*, whose
  compact spark was a couple of bars. **Numbers** is three figures in a
  row; each label is a menu of what sits there (spent, burn rate, tokens,
  cache hit rate, last call, time working, turns, tool calls), never the
  same one twice and, for the session, never the figure already beside the
  agent; the choice is remembered. **Chart** is the period's spend by time
  under 96px tall, its total on the top line and the stretch under the
  pointer at its right (←/→ move it); today, 7 and 30 days come from the
  summaries already read, and a range with nothing to draw says so instead
  of drawing an empty line. A stored *Full* opens as Chart, *Compact* as
  Numbers.
- **deck:** an open CI job stays in view and folds back in one move. Its
  line is pinned at the top of the CI area with *Fold Esc*, its steps are
  bounded to the deck's height and scroll on their own, and opening a job
  closes the one before. Esc, while the focus is in the deck, folds the job,
  then the open PR; the terminal keeps its own Esc. Every PR row has a
  chevron, the open PR's line stays pinned, and the current PR folded by
  hand stays folded while the app runs.

### Fixed

- **term:** one session open on the desktop and a phone no longer leaves
  the desktop's agent drawn at the phone's width. The terminal in use sizes
  the PTY (as tmux's `latest`): a phone that only opens the Terminal tab is
  drawn at the desktop's size, typing on the phone gives the PTY the phone's
  size, and focusing, clicking or typing in the desktop's terminal gives it
  back, with a full repaint. A phone's chat never resizes it.
- **app:** in a narrow inspector the cockpit's headline figure moves to the
  subagent chips' row (or under the name when there are none) instead of
  hanging alone on a line of its own.

## [0.111.0] - 2026-10-12

The 0.110.0 tag never published (its release check failed); this release
ships everything listed under 0.110.0 as well.

### Added

- **app:** multi-repo projects. *Add project* on a folder that holds several
  git repositories asks once: one project of them (the default) or a
  project each, with the repositories found as checkboxes. A multi-repo
  project is one sidebar row; its page lists each repository's branch,
  changes, open pull requests and share of today's spend, and *Edit* renames
  it, adds or removes repositories, rescans the folder, merges repository
  projects in or splits it — never deleting a file. An agent started inside
  one of its repositories can reach the others (`--add-dir` for Claude Code
  and Codex, `--include-directories` for Gemini).
- **app:** the deck's *Pull requests & CI* cell shows what CI cost: each
  job beside its time (*macOS 4m 45s · $0.31*), each run, the runner total
  and each PR row (*✓ 9m 10s · −6% · $0.42*); *$0 · public repo* when every
  minute ran free on standard runners in a public repository, *unpriced*
  for self-hosted or unknown runners, *≥$0.42* while part of it is unpriced
  or still running — each an estimate at list rate, the rate table's
  version and source in the tooltip. The Main view adds what GitHub itself
  billed for Actions this month (*Actions this month: 1,240 min · $7.40*),
  or which token permission it needs, with a link to the token settings.
- **app:** a **Branches** view in the same cell (*PRs | Branches | Release |
  Main*): the session's repository's branches, the current one first, then
  by last activity — ahead and behind the default branch, the last commit's
  age and author, the branch's pull request with its mini pipeline, what
  Caprock's sessions on it cost and how many, and a *stale* mark (no commit
  in 30 days and no open PR). Fifteen rows, then *Show all*; a branch whose
  PR is the session's opens it in the PRs view. Read from local git, one
  cached list of the repository's pull requests and an indexed query
  (`GET /v1/sessions/{id}/branches`, migration 0051).

### Changed

- **deck:** the *Pull requests & CI* cell is dense. A run's jobs flow into
  as many columns as the deck is wide (three at about 1300px, two at about
  900px) instead of one tall scrolling column with its right half empty,
  each column lined up (OS, time, against the median, cost); an open job
  takes the whole row and its steps flow the same way. The current pull
  request opens by itself while it is open and has checks, passed included,
  so its jobs fill the room the rows used to leave empty. The cell's title
  no longer truncates, and an open PR's CI no longer scrolls sideways by a
  few pixels.
- **app:** the cockpit's Spend block opens **Compact** by default: a period
  chip (session, today, 7d, 30d), three large figures (Spent, Tokens, Cache
  hit rate) and a small spark of that period's spend, about half as tall.
  Today, 7d and 30d are every session's figures, from the existing summary.
  *Compact | Full* in its header switches back to the cells and *Spend over
  time*; both choices are remembered.
- **app:** closing a quick chat (⌘W, the tab's ×, *Close tab*) now ends its
  process, so closed chats no longer pile up as idle sessions under *Outside
  projects*. A chat that is still answering asks once first. Closing any
  other agent's tab still leaves it running.

### Fixed

- **agents:** a Claude Code session started with a first message no longer
  loses it when no project instructions are set: Caprock's own `--add-dir`
  folders came right before the message, and the flag takes every word after
  it as another folder. Each is now written `--add-dir=<folder>`.
- **ui:** a session with no cache figures yet (a quick chat that just
  started) no longer trips the session and Now screens' cache line.

## [0.110.0] - 2026-10-12

### Added

- **ui:** a *Queue* tab on Tasks (`#/queue`, also in the palette): what each
  agent Caprock started is doing now (its task-list item, how long the turn
  has run), every queued message in order with a rough range (for example "starts in 2–9 min ·
  done in 4–14 min"), and the turns finished in the last three hours.
  *Add to queue* sends to a session, or to whichever of a project's sessions
  is free first. Every estimate is a range from that project's past turns,
  labelled with its basis, and is left out under five turns.

- **daemon:** `GET /v1/queue`, and a finished notification as soon as a
  queued message's turn ends (same switches and limits as the finished
  alert).

- **github:** what a CI run cost. A new runner rate table,
  `pricing/actions.json` (version `2026-10-12.1`), holds GitHub's per-minute
  rates for every hosted runner, larger, arm64 and GPU runners included,
  copied from GitHub's *Actions runner pricing* page on 2026-10-12 with the
  source in the file. Each CI job, run and commit the deck reads now carries
  `cost`: the runner's SKU, its minutes rounded up the way GitHub bills
  them, and the dollars at list rate. Standard runners in a public
  repository are free; self-hosted and unrecognised runners say they are
  unpriced rather than guess. `GET /v1/github/actions-usage` reads the
  month's Actions usage from GitHub's billing report, only when asked, and
  names the token permission it lacks when GitHub refuses. Not in the
  interface yet.

- **app:** the session deck is one cell, **Pull requests & CI**: the
  session's pull requests, the current one first and up to three earlier
  ones, each with its state dot, mini pipeline, CI in words (*✓ 9m 10s ·
  −6%*, *✗ failed at test (windows)*, *running · 3/5 · 4m 10s*), review,
  conflict and age. A click opens a row in place into its jobs, steps,
  error lines and *Investigate*; the current PR opens by itself while its CI
  runs or failed. The Branch cell is gone: the branch is a chip in the
  header (*feat/x → main*, with what is not committed or pushed), and the
  release chip sits there too. PRs, Release and Main stay behind one switch.
  The deck lists four PRs (`GET /v1/sessions/{id}/prs`, was three).

- **app:** CI runs and jobs show their time against the median of the same
  workflow's last five successful runs: *4m 45s +18%* (amber past +20%,
  green below −10%), *≈ 3m left* or *+12% over median* while running,
  nothing with fewer than two past runs. Past runs' jobs are read once and
  kept; only while the deck is open (`baseline` on runs and jobs).

- **app:** the session deck's CI cell has a switch: **PR** (as before),
  **Release** and **Main**, remembered per viewer. *Release* is the
  repository's newest release build — found from the run a tag push or a
  release started, for any repository — with its tag, the time so far,
  *about N min left (estimate from the last K runs)* from the median of
  that workflow's past successful runs, and its jobs and steps with errors
  and *Investigate*; once done, *v1.2.3 · published 3 min ago ✓* with a
  link to the release. *Main* is the newest run of each workflow on the
  default branch, so a red default branch shows at once. While a release
  builds, a chip *Release v1.2.3 · ~6 min* shows from the other views
  (`GET /v1/sessions/{id}/ci/release`, `GET /v1/sessions/{id}/ci/main`).

- **app:** a GitLab-style **mini pipeline** beside each pull request in the
  deck, beside the release tag and beside each default-branch workflow: a
  circle per job (✓ passed, ✗ failed, a turning ring running, hollow
  queued, a slash skipped), joined within a workflow. Hover says the job,
  its state and its time; a click opens that job's steps and error in the
  CI cell, turning it to that pull request.

### Changed

- **Dark Side** is neon purple instead of crimson: a near-black violet
  ground, a glowing purple accent and cursor, neon cyan for premium, and a
  red of its own for errors. Body text stays at 5.1:1 or more.

- **app:** ⌥⌘N (Ctrl+Alt+Shift+N on Windows and Linux) now asks: it opens the
  Quick chat chooser with the agent and model you used last already picked,
  so Enter starts it and Esc cancels. 1–9 pick the agent there too.

- **app:** a subagent in the cockpit opens in place: click its row (or its
  chip at the top) to read the task the parent gave it, folded to six lines
  with *Show all*, every call it makes as it makes them, with how long each
  took and the failed ones marked, what it answered, and its model, time,
  tokens, cost and costliest tools. Finished subagents open too, and *+N
  finished* lists them as rows. New `GET
  /v1/sessions/{id}/subagents/{agent}`; `/subagents` takes `?recent=` (up to
  30) and lists up to 24 working. A new index (migration 0049) finds a
  subagent's rows without reading its parent's.

- **app:** the cockpit's subagent chips show up to 24, in groups of four
  across the cockpit's width (twelve to a row), instead of four and *+N*;
  *N subagents working* sits right under the state line.

- **daemon:** a subagent's call count includes the calls only its transcript
  recorded (a call that failed fires no hook result), so the row and the
  opened subagent agree.

- **app:** the status bar says whose load it shows: *agent cpu 17% ram 2.0
  GB* is the session's own processes (the agent and what it runs), and a new
  *caprock 160 MB* beside it is Caprock itself (daemon, app, terminal
  holders), with the split in its tooltip.

- **ui:** *Settings* in the dashboard header is a framed button with a gear,
  like *Feedback* beside it, instead of grey text.

- **app:** the agent cockpit puts what people watch first: the agent with a
  headline figure beside it, then what it and its subagents are doing now,
  its task list, the context and the plan limits; *Spent this session*
  follows, folded to one line (*Spent $12.40 · 48 turns · 1h 12m*) until
  you open it, and stays as you left it.

- **app:** the headline figure is your choice: cost, burn rate (dollars an
  hour over the last hour of activity), tokens, turns, cache hit rate or
  time working, picked from the small menu under it and remembered. The
  cells under *Spent this session* show the others, never the headline
  again.

- **app:** *Spend over time* is a row that says what it opens and opens in
  place, as wide as the cockpit, instead of a card over the block.

- **app:** the permission-mode menu is readable: each mode on two lines, its
  name large with a small mark and what it does under it, the current one
  marked with an accent bar, and why a row cannot be picked written out.

### Fixed

- **app:** the cockpit's spend over time stays inside a narrow inspector: a
  long *peak …* line no longer pushes it past the panel's edge.

- **app:** leaving a quick chat. Once its agent exited (`/exit`), the tab
  became a login shell in Caprock's own data folder, under the same name, so
  it still looked like the chat and only a reload got you out. Now the tab
  says *The chat ended*, with *Close tab* (Enter) and *Start again* on the
  same agent and model. A line above a new chat says ⌘W closes it and /exit
  ends it (× hides the line for good).

- **app:** a quick chat's tab, its sidebar row and the inspector read
  *Quick chat · Opus 5.5*, not *Outside projects* (the group it sits in).

- **app:** the update card no longer stacks on top of the version panel:
  while the panel is open (it offers the same update), the card steps aside.

- **app:** the Dock shows the new icon after an in-app update. On macOS the
  app sets its Dock tile from its own bundle's icon at every launch, and on
  the first launch of a new version re-registers the bundle with
  LaunchServices, so the cached old icon is replaced without restarting the
  Dock.

## [0.109.1] - 2026-10-12

### Changed

- **app:** the Dock and taskbar icon is a large filled amber triangle on a
  dark tile, sized to the macOS icon grid, in place of the outlined mark that
  filled its square and read small beside its neighbours.

## [0.109.0] - 2026-10-11

### Added

- **Seven themes, with plain names:** Dark Warm (once Graphite), Dark Cold
  (once Slate), Light (once White) and Book (once Paper), plus three new
  ones — **Light Cold**, a blue-grey white with an electric blue accent and
  no orange; **Light Side**, pale sand with a blue accent, green for success
  and a soft glow; and **Dark Side**, near-black with a glowing crimson
  accent, where danger turns rose-magenta so it never reads as a button. The
  picker groups them Dark then Light, the switch-theme command walks all
  seven, and a theme kept under an old name opens as its new one. Each new
  theme has a terminal palette of its own, also in Settings → Terminal.

- **Every theme reads at 4.5:1 or better:** faint text was lifted in Dark
  Warm and Dark Cold and darkened in Light, and Light's accent is a shade
  deeper, so body and secondary text clear 4.5:1 everywhere.

- **app:** change a running session's permission mode. A chip in the session
  header and the agent cockpit says the mode a Claude Code session is in; for
  one Caprock started it is a menu. Default, accept edits, plan, bypass (when
  the process can reach it) and auto are switched in place by Shift+Tab,
  typed in and checked on the session's own footer; bypass in a process that
  cannot reach it, and don't ask, are *Restart in …*: after a confirm, at the
  prompt only, the same conversation is resumed in a new process in the same
  tab, with the one-time bypass consent where it applies. A session started
  elsewhere shows its mode read-only. New `GET
  /v1/sessions/{id}/permission-mode` and `POST
  /v1/agents/{id}/permission-mode` (ADR-054).

### Changed

- **Slate's terminal is cool too:** in Slate, the terminal (app, dashboard and
  phone) takes a neutral ground, a blue cursor and a cool 16-colour set
  instead of graphite's warm one, and follows a theme switch while open. It
  is also a palette of its own in Settings → Terminal.

- **Send feedback** picks Bug, Idea or Question from three large cards with
  an icon, a line each and their key: press 1, 2 or 3 (any keyboard layout)
  and type the title straight away. Enter in the title moves to the
  description, ⌘↩ (Ctrl+Enter on Windows and Linux) creates the issue, and
  each kind asks its own question ("What broke?").

- **Slate** has no orange left: waiting and idle marks read as a cool yellow
  there instead of graphite's amber.

- **agents:** a new Claude Code session is started with
  `--allow-dangerously-skip-permissions` where the bypass warning was already
  accepted, so bypass is a Shift+Tab away in it without being its mode
  (ADR-054). Without that consent nothing changes.

### Fixed

- **agents:** text pasted in Russian, Greek, Japanese or any other non-ASCII
  script no longer turns to `\316\272\316\261…` or `<00ad>` in a session or
  shell Caprock started. The bytes always arrived intact; the session had no
  locale, because launchd sets none and a terminal application, not the
  profile, usually exports `LANG`. A session without one now gets a UTF-8
  `LANG` (`en_US.UTF-8` on macOS, `C.UTF-8` on Linux); a locale you set is
  kept.

- **app:** the sidebar has no *Waiting on you* section any more — everything
  in it was already in Projects. A session that waits on you is marked on its
  own row instead: an amber edge and tint and the word *waiting*, or *asks*
  at a permission prompt. One started in another terminal is a row of its
  own rather than behind *Running in other terminals*, and a project folded
  by hand still shows what waits in it. The Today strip's *Waiting* count
  still opens the first one.

- **app:** every row under a project can now be closed or hidden. A row with
  no tab — an agent whose tab you closed, or a session from another terminal
  — has a × that hides it from the list (it keeps running, and nothing is
  ever sent to a session Caprock did not start), next to ■ *Stop…* for what
  Caprock started, which still asks first. Hidden rows wait behind *N hidden
  · show* under the project, where an eye brings each one back, and one
  comes back by itself when it next waits on you. The same actions are on a
  right-click or Shift+F10, a tab's menu adds *Close tab and hide from the
  list*, the buttons are bigger (26px), and on a touch screen they are
  always shown.

## [0.108.1] - 2026-10-11

Ships everything listed under 0.108.0: its tag failed the release lint on a
test helper and published nothing.

### Fixed

- **ci:** the session todos test helper no longer trips golangci-lint
  (`unparam`, `QF1008`), which stopped the 0.108.0 release before it built.

## [0.108.0] - 2026-10-11

### Added

- **app:** the agent cockpit shows the task list the agent keeps for itself
  — Claude Code's TodoWrite and TaskCreate/TaskUpdate, OpenCode's todos,
  Codex's plan — one large row per task with a spinner, a check or an empty
  circle, the task in hand as the agent words it, and *3 of 7 done* above.
  Not there when the session kept none. New `GET /v1/sessions/{id}/todos`.

- **Lifetime → Daily cost** has its own period (30d, 90d, 180d, all) and a
  **×2** height toggle; both are remembered.

- **Four themes, picked by hovering:** Graphite, **Slate** (new — a neutral
  dark with a soft blue accent), Paper and White. The theme button opens a
  picker: hover a palette to see it on the whole app, click to keep it.
  Settings → Appearance shows the same four as large swatches.

- **app:** tabs in the sidebar show their jump key, ⌘1–⌘9, as the tab strip
  does.

- **Phone: chat first.** Now on a phone starts with the running sessions,
  one tap each into that session's chat. A session on a phone is the whole
  screen: the page header steps aside, **Chat | Terminal** is one large
  switch, the conversation fills the screen with the field at the bottom
  (above the keyboard when it is up), and Esc, Tab, the arrows and Ctrl+C
  fold behind **Keys**. A session that cannot be typed into from here says
  why where the field would be — started outside Caprock, ended, or this
  phone is view-only — with **Branch here to type** or **Continue here**
  when that works.

- **Voice input in the phone's chat.** A microphone button dictates into
  the field, live, to read and then send; the browser's own speech
  recognition does it (Safari sends the audio to Apple's service, and the
  button says so while it listens), Caprock gets the text. Browsers allow
  the microphone only on https pages, so over Caprock's plain-http Wi-Fi or
  Tailscale address it says in one line to use the keyboard's dictation key.

- **Pairing says where the phone will work**, beside the code: only on this
  Wi-Fi, or anywhere while Tailscale is on on both devices.

- **app:** each project in the sidebar draws its last hour as a small line —
  amber while something in it works — and has a **+** for a new agent there
  without hovering. A chevron folds a project by hand, even one with
  something running; the choice is kept. `GET /v1/activity` serves the line.

- **Plan limits asks for your plan** until it is set, saying why: Caprock
  can't detect it, and Cost needs it to weigh usage at API prices against
  what the plan costs. *Set my plan* opens the list in place.

- **app:** the session deck's first cell is now **CI**, the live GitHub
  Actions of the session's pull request: a row per job with its state (a
  turning ring while it runs, ✓, ✗), the step it is on or failed at, its
  OS and its time, ticking while it runs; a job opens into its steps with
  their times, and a failed step into the lines around the error in its
  log, with *Open on GitHub*. At the top, the runner time so far, measured
  from GitHub's job times and split per OS, never priced. Asked every 12 s
  while a job runs, else every minute, only while the deck is open
  (`GET /v1/sessions/{id}/ci`, `GET /v1/sessions/{id}/ci/jobs/{job}/log`).

- **app:** **Investigate** on a failed CI job queues it into the agent in
  front — the PR, the workflow, job and step, the job's link and the last
  40 lines of its log, with "investigate and fix; push to the same branch" —
  through the message queue, so it types in at the prompt or when the turn
  ends. Only into a session Caprock started, from a device that may
  control; otherwise the button says why it is off.

### Changed

- **app:** the pinned Dashboard or Settings tab is its icon and its key —
  ⌘0, or ⌘, for Settings — the name in the tooltip.

- **app:** the sidebar's *Projects* heading counts them — *● 3 of 12* has
  something running — and *Outside projects* can be hidden like any project.

- **app:** the inspector's plan windows answer "will it last?" at a glance —
  a tick on each bar where an even pace would be, the percentage large, and
  one line: *resets in 4 h 56 min · ✓ enough*, or *⚠ out at 23:50* when the
  current pace runs out first. A click shows the details; the plan itself
  is in the header, to confirm or change.

- **app:** the update card says it in one line, large — *Update 0.107.6 →
  0.107.7* — with one short line under it and bigger buttons.

- **app:** the version panel is the version, whether it is current, when it
  was checked, the update button and *Release notes →*. The release notes
  themselves left the panel, where they were unreadable.

- **terminal:** an image pasted, dropped or sent from the phone's photo
  button shows in Claude Code as `[Image #1]`, `[Image #2]` instead of a long
  path. Each image goes in as its own bracketed paste of its quoted path —
  measured against the real `claude`, the only form it attaches; typed, the
  path stays text. Other files, and a shell that never asked for bracketed
  paste, still get the quoted path.

- **Lifetime:** the big figures are short — *$16.8k*, *$159* — with the
  exact sum on hover. Top projects' rows start with the donut's colour and
  the share, large.

- **app:** every shortcut hint is drawn as a large key — New agent, Quick
  chat, Add project, Dashboard, Settings — on macOS, Windows and Linux alike.

- **A lighter terminal on a phone or tablet:** no WebGL, no blinking cursor,
  2,000 lines of scrollback, and output handed over at most ten times a
  second. Under a 4x CPU throttle at 390px, a busy synthetic session took
  0.6 s of main-thread time per 10 s, from 3.2 s. A desktop is unchanged.

- **Plan limits** is two matching cards, Claude and Codex, each with its
  character and both windows side by side — 5 hours and Week — in larger,
  shorter words. A window an agent did not report is an empty ring that
  says so, instead of a missing one.

- **ui:** the Tasks screen says what it is and how to start. One sentence and
  a worked example (you write the task, a worker does it on its own branch,
  Caprock runs your checks, you merge), then a gallery of templates — fix
  failing tests, bump a dependency, add tests for a file, fix lint and type
  errors, write docs for a module, port a script — that open the form
  prefilled. Their checks are the commands the repository declares (Makefile
  targets, package.json scripts, go.mod, Cargo.toml, pytest/ruff/mypy when
  configured), found by the new `GET /v1/hive/starter`, never guessed. The
  budget field starts empty with the daemon's own ceiling as the hint.

- **ui:** the board is one list grouped by what each task needs — Needs you,
  Working, Waiting to start, Finished — instead of six narrow columns, and
  each row says what the task is doing now, how its checks went, what it cost
  against its budget, and its one action (Approve/Reject, Review & merge,
  Open). A queued task with nothing moving says the orchestrator has to be
  started, with the button.

- **A new queue directory starts empty.** It no longer gets an example task
  in the inbox, which the board showed as waiting and the orchestrator would
  assign with checks guessed for the repository; the format is in its README.

### Fixed

- **app:** the permission card's Y, N and A work on any keyboard layout; on a
  Russian one Y typed a Cyrillic letter and did nothing.

- **ui:** every banner is one design — a small scene drawn from Caprock's own
  characters on the left, a bold title, one short line, one button and a
  quiet dismiss, in one row. The team card, the Premium offers, the cap and
  plan-limit nudges, the phone and star strips, the update and hooks notices,
  the plan question and the locked panels all use it, in every theme. Figures
  are short ($16.8k), with the exact sum on hover.

- **Settings is quick to scan:** larger titles, buttons and checkboxes; the
  explanations are hidden until you turn on *Show explanations* or press a
  section's **?**; a section's title folds it, and the fold is remembered.

- **app:** Cmd+C in a terminal copies on any keyboard layout and says
  *Copied · N chars*; on a Russian layout it copied nothing and macOS beeped.

- **app:** a pull request in the deck with no checks no longer reads "CI no
  CI": a fresh one says *CI not started* (GitHub has not reported its checks
  yet), one older than 10 minutes says *no checks*, each with a tooltip.

### Removed

- **app:** the deck's *Context* cell: the status bar already shows it.

## [0.107.7] - 2026-10-11

### Added

- **Settings has a sections menu:** on a wide window a list of every section
  sits left of the page, each with a simple icon, the one in view marked;
  a click scrolls there. Section headings carry the same icons.

### Changed

- **app:** a tab is named by its project — the repo — alone. A second tab of
  the same project adds its title, faint; the title is in the tooltip.
- **Now:** *At a glance* — the donuts — comes before *All time*, the exact
  table: the pictures first, the numbers after.
- **Feedback is an amber bug** in the header and the sidebar, in place of a
  grey speech bubble that went unseen.
- **Now:** the agents folded to icons are twice the size and shrink with the
  window on one line; hovering one shows a card — its share, spend, turns
  and cost per turn — instead of a one-line system tooltip.
- **app:** keys drawn as keys (the deck's *Review changes ⇧⌘G*, the tabs'
  ⌘1–⌘9) are drawn darker and bolder; the faint chip went unseen.

### Fixed

- **app:** the keep-awake mark in the status bar stays when keep-awake is
  off — it reads *awake off*, and a click opens the modes — instead of
  vanishing with no way back from there.
- **ci:** the PTY resize test waits for the process to report its size
  instead of sleeping, which flaked on a slow macOS runner.
- **Windows, Linux:** ⇧⌘E (split down) and ⇧⌘0 (reset the interface size)
  are Ctrl+Alt+Shift+E and Ctrl+Alt+Shift+0 there; as Ctrl+Shift they hit
  other commands. A test now presses every listed shortcut as each OS spells it.

## [0.107.6] - 2026-10-11

### Changed

- **app:** the inspector's spend spark says it opens: a large *Spend by time
  ↗ click* label on hover and a small ↗ in its corner at rest.
- **The theme button walks all three palettes:** Graphite → Paper → White,
  its label naming the next one. It only flipped light and dark before, and
  Paper or White was a trip to Settings.

## [0.107.5] - 2026-10-11

### Changed

- **app:** the session deck's top edge is the faint accent line again, as
  in 0.107.3: it sets the deck apart without catching the eye.

## [0.107.4] - 2026-10-11

### Changed

- **app:** the inspector's spend spark opens, on a click, the session's
  spend by time instead of a bar per model call: bars follow the clock
  (5 min to a day, by the session's length), and a stretch reads as when,
  what it cost, how many calls and which tools. It stays open until closed.
- **app:** the session deck's top edge is a plain hairline; the accent
  line with its glow was too bright.

### Added

- **app:** ⇧⌘G (Ctrl+Shift+G) opens the diff of the session in front — its
  worktree's Changes view — from anywhere in the workspace; the session
  deck's *Review changes* shows the key.

## [0.107.3] - 2026-10-11

### Changed

- **app:** the session deck's pull requests line up in columns — CI, then
  state — and a click on the CI opens the run on GitHub: the failing or
  running job when GitHub links it, else the PR's Checks tab. The deck's
  top edge glows less.

## [0.107.2] - 2026-10-11

### Changed

- **Tasks, before the task runner is on, is large and plain:** one headline
  (*Hand off a task. Get it back green.*), three big numbered steps, and a
  filled *Turn on the task runner* button.

## [0.107.1] - 2026-10-11

### Changed

- **app:** the session deck is a third lower and keeps only what helps
  while typing: context, branch, and pull requests with CI — a merged one
  now says *CI ✓ 12 · merged*. *Now* and *Spent* left it (the sidebar and
  the inspector carry them), so it no longer follows the session's events.
  Its top edge is an accent line that frames the prompt above it, and a
  *Hide ⌘B* button sits on it.

### Fixed

- **app:** the inspector's content no longer runs past its right edge.

## [0.107.0] - 2026-10-11

### Added

- **The session deck shows the session's pull requests and their CI.** Its
  latest three PRs with a dot each — passed, running (*CI 3/5*), failed
  (*CI failed: windows*), merged — and a click opens one on GitHub. Without
  GitHub connected, *connect GitHub for CI* turns it on through your `gh`
  login in one click. Beside it the branch, with how many files are not
  committed and commits not pushed. The per-minute chart and the plan
  windows left the deck; the dashboard and the sidebar carry those.

## [0.106.1] - 2026-10-11

### Fixed

- **app:** on Windows and Linux the desktop app now replaces its own daemon
  when an update brings a new one, as it already did on macOS. Before, the
  app updated and its daemon stayed on the old version, so the status strip
  and the update banner reported a version the app had left behind.
- **app:** when the app and its daemon still run different versions, the
  version in the status strip gets an amber dot and its panel says which is
  which and what to do.
- **app:** the Keep awake panel says what is happening in a few large words,
  has one short line per mode and a close button.
- **app:** the session deck's button says *Deck* and shows ⌘B, and the
  deck's per-minute chart is as tall as the figures beside it.

## [0.106.0] - 2026-10-11

### Changed

- **Dashboard panels fold.** The arrow on a panel's title folds it to that
  title and back, remembered; the agents row on Now folds to one line of
  characters with their shares.
- **Plan limits and the daily cap lead the Cost screen.** They were below the
  month; they are what the screen is opened to check.
- **Daily cost has a time axis.** Months and Monday ticks run under the
  bars, and the hovered day reads as a weekday and how many days ago.
- **Larger figures** in the dashboard's stat tiles.
- **The version in the status bar opens what you need about updates.** A
  click shows whether a newer release is out and when Caprock last checked,
  the one-click update (or the command for how it was installed), the first
  lines of what changed and *Check now*; a dot beside the version says an
  update is out. It replaces the bare *what's new* link.

### Fixed

- **Links to the browser open from the desktop app on Windows.** *download
  it* in the update banner opened nothing there; every link meant for the
  browser now goes through the app's own opener.

## [0.105.0] - 2026-10-11

### Added

- **The session deck under an agent's terminal.** ⌘B (Ctrl+Shift+B on
  Windows and Linux), the strip's deck button or the palette opens a band
  under the terminal of the agent in front. It lifts the terminal's bottom,
  and Claude Code's prompt with it, off the window's edge, and fills the
  room with the session's live figures in one row: its state and what it is
  doing this second, what it has cost and what the last call cost, how full
  its context is and what the next call pays to re-read it, the plan's
  5-hour and weekly windows, and the last hour as one bar per minute. Taller,
  it adds the last few tool calls, turns and tool calls, and the files
  changed in its checkout. Drag its top edge (or focus it and use the arrow
  keys) to resize it, up to 60% of the pane; double-click for the default.
  It is closed by default, its height and whether it is open are remembered
  per machine, shell tabs have none, and closed it costs nothing: it reads
  the figures the inspector already holds, sharing one fetch with it.

### Changed

- **⌘0 opens the Dashboard.** It sits beside ⌘1–⌘9 like the tab before the
  first; ⇧⌘D still works, and resetting the interface size moved to ⇧⌘0
  (and ⌘K). Keys on the tabs and the Dashboard's key in the sidebar are drawn
  as keys, larger, and from five open tabs the Dashboard tab folds to its
  icon and key.
- **Charts and exact numbers, both drawn.** Model mix, What it went on and
  Per project on the Cost screen each open with a donut, and every table
  row's share is a bar in its slice's colour. On Lifetime the Charts / Numbers
  switch is larger, the numbers carry the same bars, and Daily cost sits
  right under the totals instead of at the bottom.
- **Keep awake says whether it is on right now.** The cup in the status bar
  is in colour with a green dot while Caprock holds the computer awake and
  reads *may sleep*, faint, while it does not; a click explains it and
  switches the mode there.
- **The full breakdown is a row of its own.** *Every tool, model and
  project* under the All time panel on Now is a full-width row instead of a
  faint link in the corner.
- **The daemon starts lighter.** Shortly after a start Caprock counts a
  whole-history report for the share dialog, and that count used to read
  every tool call's full payload — an edit's payload carries the whole file
  it edited. It now reads only the fields it counts, keeps a command's output
  only where it can mark a commit or a pull request, and normalises tool
  inputs in one pass instead of four regular expressions. On a copy of a
  1.9 GB database, measured 2026-10-11, the daemon's memory footprint 90
  seconds after a start fell from 678 MB to 85 MB, and the report's figures
  are byte for byte the same.
- **The dashboard costs less to keep open.** Five parts of it ask for your
  whole history once a minute and the cost strip asks for today's summary
  every few seconds; each ask counted it all again even when no agent had
  written anything. Caprock now checks whether anything was written since
  the last count and reuses the answer when nothing was. Measured 2026-10-11
  on a copy of a 1.9 GB database with the Now screen open and no agent
  working, the daemon used 11.5 s of CPU over two minutes before and 4.7 s
  after.

- **The block at the bottom of the sidebar folds.** The arrow beside
  *Send feedback* collapses feedback, Dashboard, Settings and the theme
  switch to one row of icons, and the arrow there brings the rows back.
  The app remembers which way you left it.

## [0.104.0] - 2026-10-11

### Added

- **Queued messages in the chat.** Send while the agent is still working
  and the message waits under the conversation as a *Queued* bubble;
  Caprock types it in when the turn ends — one message per turn, in order,
  and never into a permission prompt or a question. Each bubble has
  **Edit**, **Cancel** and **Send now**. The computer holds the queue, so
  the phone and the Mac show the same one and a phone going to sleep loses
  nothing; it is dropped when the session ends. For Claude Code sessions
  Caprock started, with its hooks on; other agents are typed into at once,
  as before.
- **`/` and `@` in the chat field.** `/` at the start lists the agent's
  commands — Claude Code's own, your project's `.claude/commands` and
  skills, and yours in `~/.claude` (Codex: its own and `~/.codex/prompts`);
  `@` lists the files in the session's folder, filtered as you type.
  ↑ ↓ Enter and Esc on a keyboard, big rows to tap on a phone. Picking
  only fills the field.

### Changed

- **The desktop app no longer reads its daemon whole to see whether it
  changed.** On every start it compared the bundled daemon and terminal
  holder with the installed copies by reading each file into memory; it now
  compares them in small chunks and copies with the file system.

## [0.103.0] - 2026-10-11

### Added

- **Start an agent from a GitHub issue or pull request.** In *New agent*,
  for a project on GitHub with GitHub connected in Settings, *From a GitHub
  issue or pull request…* lists the open ones — number, title, author,
  labels — searchable by any of them; ⌘K → *New agent from issue…* opens
  it directly. An issue fills in a new copy named after it
  (`issue-123-short-slug`) and a first message with its title, link and
  text. A pull request also starts the copy at its latest commit, fetched
  with your own git credentials (a fork's too), with a message to review
  and continue it. Everything stays editable before *Start*. The list is
  read only when you open the picker, through the GitHub connection you
  already have.

### Changed

- **Each terminal takes about half the memory.** The process that keeps a
  terminal alive across a Caprock restart (one per shell or agent tab) is now
  a small program of its own, `caprock-pty-host`, shipped beside `caprock`,
  instead of the whole of Caprock run in a special mode. Measured on an M1 Pro
  Mac, macOS 27, on 2026-10-11, twelve idle login shells over three runs, each
  holder process: 11.2 MB of memory before and 4.7 MB after (median physical
  footprint, as Activity Monitor counts it; resident size 20.3 MB before,
  10.9 MB after). Sessions behave exactly as before, and a session started
  before the upgrade keeps running in the holder it started in. If
  `caprock-pty-host` is missing — a `go install` build, say — terminals are
  held by `caprock` itself, as before.

## [0.102.0] - 2026-10-11

### Added

- **One prompt, several attempts, compared by cost.** In *New agent*, with
  *New copy from a branch*, set *Attempts* to 2, 3 or 4: the same agent gets
  the same first message in that many separate copies, all from the same
  commit, each with your `.worktreeinclude` files and setup command. They
  open as tabs (*attempt 1/3 · …*). *Compare attempts* (⌘K, or *Compare* in
  the inspector) sets them side by side: what each is doing, files and lines
  changed, what it has cost so far and how long it has run, with *Open* and
  *Review changes* on each. Nothing is merged for you; keep the one you want.

- **Clean up copies.** A project's ⋯ menu, or ⌘K → *Clean up copies…*,
  lists every git worktree of the project with its branch, last commit, size
  on disk and whether it is merged, pushed, has uncommitted changes or has an
  agent running in it, plus the total the copies take. Tick the ones you are
  done with (*Select merged and clean* picks those that lose nothing) and
  remove them, optionally with their merged branches. Only copies Caprock
  made are removed, never the main checkout; one with work not saved
  anywhere else asks again and says exactly what would be lost, and one with
  a session running in it stays.

- **Saved prompts and commands.** Save what you type over and over — *Run the
  tests and fix what fails*, or a shell line like `pnpm dev` — with a name,
  for every project or for one (Settings → *Saved prompts and commands*).
  Press ⌘K, or + in the tab strip → *Run saved…*: a prompt goes to the agent
  in front (or opens *New agent* with it), a command runs in a new shell tab
  in the folder in front. On your phone, your prompts are chips above the
  message field: tap one, then Send.

- **Caprock keeps your computer awake while agents work.** A long run no
  longer stops because the computer idled to sleep. It lets go once nothing
  is working; the screen can still turn off, and closing a laptop's lid
  still sleeps it. *awake* in the status bar says when it is holding.
  Settings → *Keep awake*: Off, While agents work (the default), or Always.
- **Review notes on the diff, sent to the agent.** In the Changes view,
  click a line number to leave a note on it (⇧-click for a range); notes sit
  under their lines and stay with the worktree. **Send to agent** types them
  all, each with its file, lines and code, into the session Caprock started
  in that worktree as one message — or starts a new agent there with them
  when none is running.
- **Fix with agent.** A commit or push your git hook refused, files left in
  conflict, and a pull request's failing checks or conflicts each get a
  **Fix with agent** button in the Changes view: the output goes to the
  agent working in that worktree (or a new one there) with a short
  instruction to find the cause and fix it.

### Fixed

- The Changes view said "A merg is under way" during a merge (and "rebas"
  during a rebase); it now names the operation, and a hook's coloured output
  is shown without its escape codes.

- **New copies are ready to run.** A new copy of a branch from *New agent*
  (or the sidebar) gets the ignored files your repository lists in
  `.worktreeinclude`, such as `.env`, copied from the project's folder. Give
  a project a setup command (*Setup*, under the new copy in *New agent*), such
  as `npm install`, and it runs in the agent's terminal before the agent
  starts, with its output there; Ctrl+C skips it, and a failure or ten
  minutes starts the agent anyway.

## [0.101.3] - 2026-10-11

### Changed

- **Hide a project with one click.** Hovering a project shows an eye; one
  click moves it under Hidden, even while something runs in it (it keeps
  running there, with its dot). It comes back out only when it is the
  current project or something in it waits on you.
- **Other folders is now *Outside projects***, with a tooltip saying what
  it holds: sessions in folders not added as a project.

## [0.101.2] - 2026-10-11

### Changed

- **Every project where something runs stays open in the sidebar.** Its
  sessions are listed under it whichever project is current, so one click
  opens any of them and picking one never folds another. Projects with
  nothing running still fold.
- **Settings is a row you can find.** The sidebar's bottom now has
  *Settings ⌘,* by name, with a gear and *phone, Telegram* beside it,
  instead of a bare sliders icon, and Dashboard and Settings are outlined
  so they read as buttons; the palette gains *Connect Telegram*.

## [0.101.1] - 2026-10-11

### Changed

- **At a glance, Numbers, draws its shares.** Each block leads with its
  largest share in large type, a bar of the whole in the donuts' colours,
  and a bar under every row the width of its share; two blocks to a row
  unless the window is very wide.
- **New agent starts on Claude Code, not on whatever ran last.** One Codex
  session no longer makes every later New agent Codex. To start on another
  agent, pick it and press *Make default* beside the Agent label.
- **The keys on Start and Cancel are big enough to read**, in both themes:
  a larger chip, and on Start a solid one in the button's inverse colours.
- **Telegram set up from three large steps.** Settings → *Telegram* now
  leads with *Make a bot*, *Paste its token* and *Send it a code*, an *Open
  @BotFather* button and one *Connect* button; the alert switches appear
  once the bot is connected, with a note if every alert is off. What a
  message says is folded away.

## [0.101.0] - 2026-10-11

### Changed

- **The phone section reads at a glance.** Three large steps — same Wi-Fi,
  scan the code, let it work — and one large *Show a code* button whose text
  is readable in the dark theme; the rest is folded under *Then: …*. After a
  restart, with phones paired, the section leads with *Phone access is off*
  and a large *Turn on*.
- **Keys on buttons you can read.** *Start ⌘↩* and *Cancel Esc* (and the
  same pair on Add project, Quick chat and Send feedback) carry the key as
  a bordered chip at full contrast, on taller buttons. The feedback dialog
  is wider, with larger text throughout.

### Added

- **Take Caprock with you.** A slim strip above the status bar offers *Open
  on your phone* and *Connect Telegram*, each opening its Settings section.
  It ticks an item off by itself once a phone is paired or the bot has a
  chat, *Not needed* drops an item for good, × hides it for a week, and
  once both are done or skipped it never comes back.
- **Interface size in the app.** Settings → Appearance sets 100, 110, 125
  or 140%, and ⌘+ / ⌘− / ⌘0 (Ctrl+Shift off macOS) step it. The window
  zooms natively, terminal included. The app now opens at 110%.
- **Talk to your agents from Telegram (Premium).** Reply to a session's
  message in Telegram and Caprock types it into that session and presses
  Enter; the answer comes back in the chat as soon as the turn ends, with
  code blocks left out unless you switch them on. *Approve* and *Deny* answer
  a question the way the app's card does. `/sessions` lists what is running,
  `/new <project> <message>` starts Claude Code in a project (Bypass asks
  first), `/stop <n>` stops one. Only sessions Caprock started are typed
  into. Off until switched on in Settings → *Talk to your agents from
  Telegram*. It runs through your own bot: no server of ours, nothing
  listening on your computer, and it works on mobile data. See
  [docs/telegram.md](docs/telegram.md).
- **Telegram set up in two steps.** Settings → *Telegram*: paste the token
  from `@BotFather` (Caprock checks it with Telegram before keeping it), then
  send your bot the six-digit code shown — one tap from the button. No more
  copying a chat id out of `getUpdates`; a chat id typed in before keeps
  working.
- **Every Telegram message says whose it is.** The first line is now the
  agent, project and session — *🟠 Claude Code · caprock · Fix the cache
  test* — and what happened moves to the second. Alerts carry *Mute this
  session* and, with phone access on, *Open on phone*; `/mute all` and
  `/unmute` work from the chat. Free, like the alerts.
- **More than one sign-in.** Settings → *Subscriptions* keeps several Claude
  Code or Codex accounts side by side, each in a folder of its own. *Add
  subscription* types the agent's own sign-in into a shell tab for you to
  run; Caprock never sees a password or token. Each one shows the account it
  is signed in to, its 5-hour and weekly windows and its last seven days.
  New agent and Quick chat get a *Subscription* picker, remembered per
  project; the session runs on it and its card says which. Near 90% of a
  window, the picker says so and offers one with room for the next session —
  running sessions never move and Caprock never switches on its own. Three
  per agent are free, your own sign-in included; more are Premium.
- **See what your sessions cost the machine.** While Caprock is open it
  samples every live session's processes every 5 seconds: the status bar
  shows the session's CPU and memory, the inspector lists its three busiest
  processes, and a quiet flame marks the sidebar row and the tab of a session
  that has used a full core or 2 GB for over a minute (`GET
  /v1/resources`, a `resources` frame on `/v1/live`). Nothing is sampled
  while no window is open.
- **Settings → About shows Caprock itself**: the daemon, the app and the
  terminal holders, with their memory and CPU, and how many holders are
  orphans, with a button that stops them (`POST /v1/resources/reap`).
- **`CAPROCK_PPROF=127.0.0.1:<port>`** serves Go's profiler on a separate
  loopback listener, off unless set. See `.ai/10-infrastructure.md`.

### Fixed

- **Orphaned terminal holders are stopped.** A `caprock pty-host` of this
  Caprock whose program has exited, or that nothing can reach any more and
  holds only an idle shell, is stopped five minutes after Caprock starts and
  hourly after that. Holders left by another data folder (a deleted demo or
  test install) are stopped from Settings. One that runs an agent or a
  command is never stopped. On the machine this was measured on, 15 holders
  left by a deleted demo data folder held about 13 MB each.
- **The daemon uses less CPU and memory.** A file write no longer re-checks
  every transcript (only the written one; a 2-second sweep covers files
  written in the last 10 minutes), the storage breakdown reads the events
  table once instead of sorting it through temporary files, and SQLite's page
  cache is 16 MiB per connection instead of 64. Measured on a copy of a
  1.8 GB database with 1,264 transcripts, two terminals and a steady stream
  of activity: CPU 3.8% → 3.1%, memory footprint 263 MB → 122 MB, the
  storage measurement over 40 s → 6.7 s.

## [0.100.0] - 2026-10-10

### Added

- **Start an agent from a fresh main.** New agent's *Where* leads with *New
  copy from a branch*: pick the branch it starts from in a search that puts
  the main branches first (the default one on top) instead of a list of
  every branch, and the copy starts from the latest of it on the server —
  Caprock fetches it first unless you untick *Pull the latest*. Choosing a
  new copy is remembered, so the next agent starts the same way.

### Changed

- **The phone section reads at a glance.** Three large steps — same Wi-Fi,
  scan the code, let it work — and one large *Show a code* button whose text
  is readable in the dark theme; the rest is folded under *Then: …*. After a
  restart, with phones paired, the section leads with *Phone access is off*
  and a large *Turn on*.
## [0.99.0] - 2026-10-10

### Added

- **Find a project by typing a few letters.** New agent's Project field is
  now a search that opens with the cursor in it: type any part of a name
  ("capr") and pick from the projects you added, the folders you worked in
  recently and the git repositories under your default folder (two levels
  deep). The matched letters are bold; ↑↓ and Enter pick, Esc closes the
  list. The current project is first, so Enter, Enter still starts at once.
  Picking a repository that is not a project yet adds it and selects it.
- **Add a project suggests as you type.** Typing in the Folder field lists
  the same matches live; *no such folder* appears only when nothing matches,
  and then with the nearest names (*Did you mean ~/dev/caprock-web?*), one
  click from being filled in.
- **Grok.** xAI's Grok Build CLI (`grok`) starts from New agent and Quick
  chat like the other agents, with its own models, permission modes and
  your project's instructions. Caprock keeps its sessions in your list but
  does not read their turns or cost yet.
- **Agents that are not set up say how to set them up.** New agent lists
  the agents that are not installed after the others, never picked for you;
  choose one to see its official install command, with *Install in a shell
  tab* (the command is typed into a new shell, not run), Copy and its docs.
  Quick chat names them under its list.
- **Custom agents (Premium).** Settings → *Custom agents* adds any terminal
  coding agent by name, command and arguments, with `{prompt}` and `{model}`
  where the first message and the model go. It appears in New agent and
  Quick chat and opens in a tab.

### Fixed

- **OpenCode no longer offers an empty model list.** It lists the models of
  the providers you connected (a key in your shell, `opencode auth login`, or
  its config); with none, it says so and offers *Connect a provider*.
- **Gemini CLI and Codex installed with npm under nvm, Volta or a custom
  prefix are found** even when the login shell's PATH does not carry them.
  Gemini CLI was never a paid feature: when its binary is not found it is
  now listed with its install command instead of being hidden.

## [0.98.1] - 2026-10-10

### Fixed

- **Voice mode can use the microphone on macOS.** Claude Code's `/voice` in
  a Caprock terminal recorded silence ("No audio detected from microphone")
  with no prompt: the app and its daemon were signed with the hardened
  runtime but without the right to ask for the microphone, so macOS refused
  every session it held Caprock responsible for (`tccd` log, 2026-10-10).
  Both are now signed with `com.apple.security.device.audio-input` and the
  app says why it asks, so macOS shows its one-time prompt; after Allow,
  recording works. Update, open the app once, and start a new session for
  voice ([docs](docs/app.md#voice-mode-and-the-microphone), ADR-045).

## [0.98.0] - 2026-10-10

### Changed

- **Working from your phone is spelled out where you set it up.** The phone
  section of Settings sits right under Appearance, and its steps now run to
  the end: pair, press *Let it control sessions* to work rather than watch,
  add it to the home screen (an iPhone pairs once more there), carry on a
  session from its Chat, and turn phone access on again after a restart. The
  command palette has *Open Caprock on your phone*, which opens that section.

- **Each tab shows its jump key.** ⌘1–⌘8 by position and ⌘9 on the last
  tab, as iTerm shows them (Ctrl⇧1… on Windows and Linux); the keys worked
  before, but only a tooltip said so.
- **The status bar carries the session in front.** With an agent's tab in
  front, the bar along the bottom shows its model, how full its context is,
  what the next call costs to re-read it, and what the session has cost.
- **What's new, in the app.** The version in the status bar opens the notes
  of the release you are running, and the update card's *What's new* opens
  the new release's notes in the app instead of a GitHub page.

### Fixed

- **Windows and Linux see their own shortcuts.** Hints, tooltips and the
  shortcuts sheet showed ⌘ on every platform; off macOS they now read
  Ctrl+Shift+N, Ctrl+Alt+Shift+N, Ctrl+Enter, F5, the keys that actually
  work there. The pane keys, which exist only on macOS, are no longer
  offered elsewhere.

- **Feedback no longer looks like a volume control.** Its icon is a speech
  bubble rather than a megaphone, and in the desktop app it is a labelled
  *Send feedback* row above *Dashboard* instead of a bare icon beside
  Settings and the theme switch.

## [0.97.0] - 2026-10-10

### Added

- **Feedback with a type, a title and screenshots.** The Feedback dialog
  now asks what it is (Bug, Idea or Question, filed with the matching
  GitHub label), a title that becomes the issue's title, and an optional
  description. Paste (⌘V), drop or choose up to four screenshots, each with
  a thumbnail and a ×. Diagnostics (version, OS, screen) sit on one line
  you can open to read or untick to leave out. *Create issue* opens the
  prefilled issue in your browser and puts screenshot 1 on your clipboard;
  a short *Attach your screenshots* step says to press ⌘V in the GitHub
  comment box and *Copy next* brings up the next one. Caprock still sends
  nothing: GitHub uploads what you paste.
- **In the desktop app: Capture window, dropped images, the real
  clipboard.** On macOS and Windows, *Capture window* attaches a picture of
  the app's own page (the dialog steps aside for it); it is drawn by the
  app's webview, so no screen-recording permission is asked. Image files
  dropped on the window are attached (png, jpg, gif or webp, up to 10 MB).
  Screenshots go onto the clipboard through the app itself rather than the
  webview, which not every webview allows.

### Changed

- **A share card worth posting.** The Figures card says one figure big —
  the period's cost at API list prices, or, with a flat plan set and a week
  or a month chosen, the multiple of the plan ("28× my $200/mo Max plan") —
  with two or three facts under it (sessions, tokens, cache hit), the agents
  that did the work as marks and shares, the caprock mark, and *What's
  yours? caprock.dev*. *At API list prices — not a bill* stays under the
  figure. Both styles come in Dark or Paper (caprock.dev's cream), chosen in
  the sheet. The sheet shows the card large, with one obvious button —
  Share… where the system has a share menu, Copy image where it does not —
  and Save image and Post to X beside it. The header's Share is an amber
  pill rather than a solid block, and the app's Today strip shows its share
  button in amber. `GET /v1/glance` takes `?range=` for the card's agent mix.
- **The macOS .dmg opens on a branded window**: cream ground, the caprock
  mark, the app and the Applications folder side by side with an arrow
  between, and "Drag Caprock to Applications".
- **The Paper light theme is caprock.dev's palette, all of it.** It had the
  site's cream surfaces but the neutral theme's grey text and light amber, so
  the app looked paler than its own screenshots. Paper now uses the site's
  warm dark-brown text, its deep amber for links and accents, and the site's
  orange button with dark text for filled controls. White is unchanged.

### Fixed

- **A file dropped on a dialog in the app no longer types into the
  terminal underneath.** The terminal checked only its own box, so a drop
  on a dialog over it typed the file's path at the prompt.
- **A long branch no longer hides what a session is.** In the sidebar and
  the tab strip the branch shrinks first and the title keeps its words; the
  title is cut only once the branch is gone, and the tooltip has both.
- **Sessions started days ago in another terminal show up under "Running in
  other terminals".** The app asked for the live sessions only after the
  first live update and dropped any answer a newer update overtook, so
  beside a busy agent an old session (a "Context recovery" left open in a
  terminal) never reached the sidebar. It now asks at once and always uses
  the answer.

## [0.96.0] - 2026-10-10

### Added

- **A share sheet worth opening.** Share shows the card itself, with Today,
  This week, This month and All time, and three ways out: **Copy image**,
  **Save image** and **Post to X** (copies the card and opens a post with the
  words and caprock.dev written; X cannot be handed an image by link). In the
  app it is in ⌘K as *Share my numbers* and in the corner of the Today strip.
  When a week closes or a milestone passes (100 sessions, a billion tokens, a
  week of 95% cache hits), a small toast offers it, at most once a week.
- **Star on GitHub, asked once.** After three days with sessions and ten
  sessions, a slim strip at the bottom of the dashboard and the app asks for
  a star. *I starred it* says thank you and never asks again; × waits a month.
- **Premium and Teams, offered when they answer something.** A Claude plan
  window at 80% offers Premium's pause before the limit (under Plan limits and
  in the app's Today strip); a day in the top quarter of your own days offers
  the daily cap on Cost; and when two or more people commit to your
  repositories, Cost and Lifetime offer Caprock for Teams. One offer on screen
  at a time, never to a licence holder, each dismissible. Dismissals are kept
  by the daemon (`settings.prompts`), so the app and a browser agree. New
  endpoint `GET /v1/team-signal` counts commit authors from git on this
  machine; counts only, nothing leaves it.

### Fixed

- **Every dialog has a way out you can see.** Each one now has the same 30px
  × in its header (44px on a phone), closes on a click on the dimmed
  backdrop, and closes on Esc: Quick chat, New agent, Add project, the
  command palette, Open file, the shell-close question, Share, Premium,
  Teams, Feedback, Version, What's new, New session, Continue in, and the
  Tasks dialogs. Quick chat had no × at all. Esc closes only the newest
  dialog, and a text selection dragged out of a dialog no longer closes it.
- **Settings has its own ×.** Beside the *Settings* heading, and Esc from
  anywhere on the page but a field: in the app both do what the Settings
  tab's × does; in a browser they go back to the screen you came from.
  Closing the Settings or Dashboard tab while it is in front no longer
  leaves the tab in the strip.
- **Feedback you can find.** The header's 11px grey *feedback* is now a
  labelled **Feedback** button with an icon, and the app's sidebar has a
  feedback icon beside Settings, on screen whatever tab is in front (a dialog
  opened from the sidebar is no longer squeezed into it). The
  prefilled GitHub issue opens in your default browser through the app's
  own link path, as a terminal link does.

## [0.95.0] - 2026-10-09

### Added

- **Scrub through a session's spend.** Hover the small per-call spark beside
  *Spent this session* in the app's cockpit (or focus it, or press it on a
  phone) and it opens over the block into every priced call of the session.
  Bars fold into runs once there are more calls than the width holds, but
  the cursor reads one exact call: *Call 412 of 640*, when, the model, what
  it cost, its tokens and the tools it asked for (*Bash go test ./...*);
  ←/→ step one call at a time, Esc or leaving closes it. A field the data
  does not carry is left out, never shown as $0. The series comes from a
  new lean endpoint, `GET /v1/sessions/{id}/calls`.
- **See the subagents at a glance.** Under the cockpit's state line, one
  small tinted avatar per subagent: its type's initial (E for Explore, G for
  general-purpose, P for Plan), pulsing while it works, accent while it waits
  on you, muted once finished; at most four and *+N*. Hover names its type,
  task and model; a click scrolls to the *Subagents* list.
- **Quick chat picks a vendor and a model.** Clicking *Quick chat* (the
  sidebar, the tab strip's + menu, or *Quick chat with…* in the palette)
  shows the agents installed here — Claude Code, Codex, Gemini CLI,
  OpenCode — and their models; a click on a model starts the chat on it,
  Enter starts the highlighted one. ⌥⌘N still starts at once, on the agent
  and model used last.
- **A default folder for new projects.** Settings → Projects, or *Set as
  default* beside the Add project sheet's folder field; the sheet starts
  there (your home folder until set) for an existing folder, a new project,
  a clone and Browse.
- **The Add project sheet says what is at the path as you type**: *will be
  created*, *exists, empty — will clone here*, *exists — not empty, clone
  will fail*, *not a folder*, *already in Caprock*. A new daemon endpoint,
  `GET /v1/browse/stat`, answers it under the folder browser's rules.

### Changed

- **Browse is a folder browser**: it opens on the default folder, with a
  breadcrumb, ↑ to the parent, double-click or Enter to go in, *Choose* to
  pick, and arrow keys throughout.
- **Recent folders leave out scratch**: temp folders, Caprock's own data
  directory (quick chats) and `.claude/worktrees` agent worktrees.
- **The Add project sheet has keys on its buttons**: ⌘↩ adds, Esc cancels,
  ⌘1–3 switch Existing folder / New project / Clone, ⌘B switches Recent and
  Browse (Ctrl off macOS).
- **A clone may go into an empty folder**, as git allows; one with anything
  in it is still refused.
- **Tabs are easier to tell apart.** The tab in front has an amber top edge;
  the others are shaded tabs of their own. The strip's + is an amber outline
  that opens a menu — New agent, Quick chat, New shell, Open file, Add
  project, each with its key; the separate new-shell button is gone. The
  pinned Dashboard tab stands apart: an amber grid icon, an amber tint, and
  a divider before the session tabs.

### Fixed

- **A session no longer takes a background agent's branch.** With an agent
  working in a git worktree, Claude Code wrote the worktree's branch on the
  parent's own transcript lines, and the session's header read the agent's
  `feat/…` branch over the main checkout's master. A live line now takes the
  branch its folder's checkout actually has, read from its `HEAD`.

## [0.94.2] - 2026-10-09

### Changed

- **The app's status bar drops "v2 · 167×36".** The front terminal's
  protocol and size sat beside the version and meant nothing to a reader;
  they are now in the version's tooltip (*terminal protocol v2 · 167×36*),
  and the bar names the terminal's state only while it is not live
  (*reconnecting*).
- **Each agent is shown by its mark, not by letters.** The app's sidebar,
  *Waiting on you*, the tab strip, the tray panel and the dashboard's
  Projects panel, pulse and Now cards named an agent with a text monogram —
  *Cl*, *Cx*, *$*, *oc*, *cdx*. Now they show a small mark in the same
  space: the Claude spark, the Gemini sparkle, the OpenCode and DeepSeek
  marks, a `C` in a rounded square for Codex and a `>_` prompt for a shell.
  Brand colours are toned down to read on graphite, white and paper alike,
  and each mark says the agent's name on hover and to a screen reader. The
  paths come from Simple Icons (CC0); nothing is fetched. Row heights are
  unchanged.
- **Closing a shell's tab closes the shell.** Until now the × of a shell's
  tab, in the strip or the sidebar, and ⌘W left the shell running, and idle
  shells piled up as muted *Shell* rows. Now it works as in iTerm, Terminal
  or VS Code: an idle shell ends with its tab, without asking; a shell
  running a program asks first — *Shell 1 is running claude. Close and stop
  it?* — with *Stop and close*, *Keep running, close tab* and *Cancel*. The
  same goes for a shell's pane in a split. Closing an agent's tab still
  never stops the agent, and the tooltips now say which is which (*Close
  shell* / *Close tab — the agent keeps running*). A shell left running
  with no tab is still a muted row with ■ to stop it. *Close project* (a
  project's ×) now ends that project's shells too, tab or no tab: idle ones
  at once, and when some run a program one question lists them — *alpha:
  Shell 1 is running claude, Shell 2 is running npm. Stop them and close?*
  — with *Stop and close*, *Keep them running, close tabs* and *Cancel*.
  Its agents are never stopped.
- **A shell says what it runs.** A shell running a program reads *Shell 1 ·
  claude* in the tab strip and the sidebar. `GET /v1/shells` carries a new
  `program` field: the shell's foreground program on macOS and Linux, read
  from the terminal's foreground process group; on Windows its child
  process, best effort. It is read at most every 2 seconds per shell, only
  for shells Caprock started, and never signals anything.
- **No "Waiting on you" block with nothing current in it.** When only turns
  put down more than 12 hours ago are left, the sidebar no longer shows the
  block with its lone *Older* line; those turns stay on the Dashboard.

### Fixed

- **Typing stays quick while other agents work.** The app redrew its whole
  window, every terminal included, on each event an agent sent (about 19
  times a second with four busy agents); now terminals are left alone and the
  sidebar updates at most a few times a second. A tab out of sight no longer
  draws what its program prints until you bring it forward, and the pulsing
  "working" dots no longer repaint the window every frame.

## [0.94.1] - 2026-10-09

### Added

- **Links in the terminal open.** Cmd+click (Ctrl+click on Windows and
  Linux) on a URL in any terminal, or on a link Claude Code prints, opens it
  in your browser; in the app, the default browser. Hovering underlines it
  and says how to open it. A plain click still selects text. Only web and
  mail links open: anything else a program prints is ignored.

### Changed

- **Closing things in the sidebar is one ×.** Each tab under the project
  has a × (always on the one in front) that closes it as ⌘W does; the
  agent or shell keeps running. A project's × closes its tabs and moves it
  under *Hidden*, or, while something still runs or waits in it, only
  closes its tabs and leaves it listed. It replaces the crossed eye. A
  running agent or shell Caprock started that has no tab gets a ■ on
  hover, and a tab's right-click menu has *Close tab* and *Stop…*; both
  ask first, as the cockpit does. Sessions started in another terminal
  have no stop. Delete and Backspace close nothing.
- **The sidebar says each thing's state, in a fixed order.** Every agent
  under the project ends in one word: *working*, *waiting* (amber, the only
  amber in the list), *idle* or *done*. Rows keep the tab strip's order,
  then the order things started, so a state change never moves one.
  Sessions started in another terminal fold into one *Running in other
  terminals · N* line instead of a row each. The tab in front is marked by
  a plain edge, no longer amber.

### Fixed

- **macOS no longer asks "caprock" for what a session did.** A `find /` an
  agent ran inside a Caprock session asked, in Caprock's name, for the Music
  library and network volumes, and an `ls ~/Desktop` for the Desktop: macOS
  counts everything a program starts as that program, and every new release
  is a new program to it, so the questions came back after each upgrade
  (`tccd` log, 2026-10-09). Sessions, shells, verify commands and the
  login-shell read now start with their responsibility disclaimed, as iTerm2
  and Chromium start theirs: a prompt names Claude Code, Codex or the shell
  that asked, and the answer outlasts both their updates and Caprock's. The
  process keeps its pid, terminal and environment (`internal/disclaim`, pure
  Go, no cgo).
- **Background reads stay out of the folders macOS guards.** The folder
  picker and the Projects panel no longer read inside Desktop, Documents,
  Downloads, iCloud Drive, cloud-storage folders, Music, Movies, Pictures or
  `/Volumes`, nor follow a link into one (a link in `~/dev` to a share is
  recognised from the link, without touching the share); the picker still
  offers those folders, unprobed, and opening one is yours to ask for.
  Finding the repository a session's folder belongs to still reads up that
  folder in Desktop, Documents and Downloads — a session there means you
  work there, and projects in `~/Documents` stay grouped by repository — but
  never in Music, Movies, Pictures, iCloud Drive, cloud storage or
  `/Volumes`, where the session keeps its folder's name.

## [0.94.0] - 2026-10-09

### Added

- **Quick chat in the app.** *Quick chat* under *New agent* in the sidebar,
  ⌥⌘N (Ctrl+Alt+Shift+N on Windows and Linux) and the palette start a Claude
  Code session without picking a folder, in a tab under *Other folders*. It
  was only on the browser's Now screen.
- **Subagents show their model and what they cost.** Each row in the
  cockpit's *Subagents* section shows the model the subagent runs on (for
  example *Haiku 4.5*), how long it has worked and what its own calls have
  cost. A dot pulses while its call runs. Up to three that finished lately
  stay listed, muted, with model, duration and cost. The section's header
  shows what all of the session's subagents cost. A cost Caprock cannot
  price is left out rather than shown as $0.

### Changed

- **The New agent sheet says what *Where* means.** *This folder · main* is
  the project's own checkout, *Existing copy · <branch>* one already made,
  and *New copy on its own branch* a separate folder on a new branch, with a
  one-line explanation and a *Branch name* field — no git vocabulary needed.
  Start shows its key (⌘↩, Ctrl+↵ off macOS), which works from every field.
  Model names fit their box: Codex's default reads *gpt-… (default)*, and
  the Claude and Gemini labels are shorter (*Opus 5.5 · all-rounder*).
- **Tabs never vanish when you pick another project.** The tab strip holds
  every open tab of every project, in the order you opened them, each with
  its project's name and colour; picking a project shows its tabs in the
  sidebar or its page, and the strip keeps the rest. ⌘1–9, ⌃Tab and
  dragging run along the whole strip. Tabs saved by an earlier version come
  back as they were.
- **A simpler project list in the app.** Only the current project is open
  in the sidebar, and under it are exactly its tabs — the ones in the tab
  strip, in the same order and under the same names; shells read *Shell 1*,
  *Shell 2*. After them, muted, whatever of that project still runs with no
  tab — a session you closed the tab of, a shell left running — and a click
  opens it as a tab; ended sessions are not listed (they are on the
  project's page and in ⌘K). No branch rows and no worktree rows. Click
  another project to make it current; there is nothing to expand or
  collapse, and the list never reorders when you click: pinned projects
  first, then by name. The tab you are looking at is the one highlighted
  row. A project's row shows only what runs in it and what waits. With more
  than eight projects, the ones with nothing running, no tab open and no
  pin fold under *More projects* (it was *Quiet*, after a week without
  activity); with eight or fewer every project shows. *Waiting on you*
  shows only when something waits.
- **Dashboard opens as a tab.** ⇧⌘D and the sidebar's *Dashboard* open Now,
  Cost and the other screens in a *Dashboard* tab pinned at the left of the
  strip, with the terminals beside it, one click away; Settings opens there
  too. In the app, Now leaves out the session cards and the projects panel,
  which the sidebar already lists; the browser dashboard still shows them.
- **The terminal matches the app.** A new colour choice, *Match app*, is the
  default: the dark Caprock palette in the dark theme and Paper on the
  window's own colour in the light one, so the terminal no longer looks like
  a dark window laid on a beige one. Caprock's ground is now the dark panel
  colour, the same as the tab strip. A palette you picked by hand is kept;
  Caprock saved before this version, when it was the default, reads as
  *Match app* — pick it again to keep it in the light theme.

### Fixed

- **A session whose background agents are still working is no longer
  "waiting on you".** When a Claude Code turn ends with subagents still
  running, Claude Code resumes the session by itself once they finish. The
  cockpit used to say "Waiting on you" beside "1 subagent working". It now
  says *Background agents working · N*. Such a session gets no waiting dot,
  is left out of the Waiting on you inbox, ⌘J and the project's waiting
  count, and sends no "finished" notification until its last subagent stops.
  A permission prompt still waits, whoever asked.
- **A subagent no longer moves its session to its own folder and branch.**
  Hooks and transcript lines from a background agent working in a git
  worktree carry that worktree's folder and branch. They overwrote the
  session's, so a session in `~/dev/caprock` on master showed an agent's
  `feat/…` branch and worktree path. A subagent's folder and branch now only
  fill a session that has none yet. A session already moved goes back with
  its main thread's next event.
- **The cockpit header names the project.** Under the title it shows the
  project's name as the sidebar shows it, then the branch only when that is
  not the project's default. The full path is a tooltip. It used to show a
  branch beside a folder path cut from the left (`…nt-a874ec5240fb37a9d`).
- **Focus no longer jumps while you fill the New agent sheet.** Each time
  the app refreshed behind it, the sheet threw the caret back to *Project*;
  now focus moves only when you move it. The same fix covers every sheet in
  the app.

## [0.93.1] - 2026-10-09

### Fixed

- **A Codex call its turn cut off no longer says "running" forever.** A call
  with no output reads "interrupted", muted, once its turn has ended: Codex
  wrote `turn_aborted` or `task_complete` (stored as a `tool.post` marked
  `interrupted`, key `codex:interrupted:<line>`), the next request started,
  the person typed the next prompt, or the session ended. Only the call still
  in its turn says "running". Any other agent's call left without a result
  reads "interrupted" at its turn's Stop or the session's end — never because
  a prompt came after it: a prompt queued in Claude Code while a long tool
  runs leaves that tool running.
- **Codex's `exec` reads as the command it ran everywhere, not only in the
  Chat.** The Timeline, the activity feed, the cockpit's tool list and its
  subagents, the Now phrase, notifications and loop alerts showed the
  JavaScript an `exec` call sends; they now show the shell command it ran,
  `apply_patch <file>` for an edit, or the tool it called. The daemon reads
  it the way the Chat does (`internal/toolcmd`). Memory shows only what the
  agent wrote, never a tool call, so it had nothing to fix.
- **OpenCode first run after the daemon started.** A daemon that found no
  OpenCode database at startup read none until it restarted or started an
  OpenCode session itself, so a session run in a terminal on a machine
  where OpenCode had just been installed stayed off Now. The daemon now
  looks for the database every ten seconds until it appears, and follows
  OpenCode 2's service stream from then on. Found while verifying OpenCode 2
  on Linux, where the rest of the support checked out end to end.

## [0.93.0] - 2026-10-09

### Added

- **OpenCode 2.** OpenCode 2 is what opencode.ai, `brew install opencode`
  and Arch now install, beside OpenCode 1 under the same command. Caprock
  reads its sessions (`session_v2` and `session_message` in the same
  database file) next to OpenCode 1's, with OpenCode's own cost, tokens,
  model, prompts, replies and tool calls (`shell` is Bash, `subagent` is
  Agent); a database OpenCode 2 migrated from 1, and a session started in 1
  and continued in 2, count each message once. The live stream follows
  OpenCode 2's background service as well. New agent asks
  `opencode --version` and starts OpenCode 2 with the flags it has:
  `--standalone --session <id>` (linked from the first byte), the model and
  plan agent as `OPENCODE_CONFIG_CONTENT`, bypass as `--auto`, and a first
  message typed once the TUI is up. `/v1/status` carries `opencode_version`.

### Fixed

- **New agent → OpenCode with OpenCode 2 installed** started a TUI with
  OpenCode 1's `--port`, `-m` and `--agent`, which OpenCode 2 does not have,
  and on a Mac with `/home` automounted OpenCode 2.0.26 hung before drawing
  anything; it now gets the flags its version lists and starts.

## [0.92.0] - 2026-10-09

### Added

- **Read a project's files in a tab.** ⌘K → *Open file…* lists the
  worktree's files and narrows them as you type; the Changes view (**o**,
  or the ↗ on a row) and the cockpit's changed files open one too. The file
  opens read-only in a tab named after it: Markdown formatted, with a
  *Source* switch and links to other files opening their own tabs; any
  other text with line numbers, wrapping and ⌘F. A binary, or the part of
  a file past its first megabyte, is left to your editor. The tab reads the
  file again when you return to it or an agent edits it. Nothing outside
  the project is ever read, through `..` or a symlink.
  `GET /v1/projects/{id}/file`, `GET /v1/projects/{id}/files`.
- **A stop at the plan limit (Premium).** When Claude's 5-hour or weekly
  window passes the share you pick in Settings → *Pause at the plan limit*
  (90% until you change it, or off), Caprock pauses the Claude Code sessions
  it started, names them on Now and in a desktop notification with the reset
  time, and resumes them after the window resets. A session you resume by
  hand is left alone until the next window; a session you started yourself
  is never touched; figures more than ten minutes old pause nothing, and
  Settings says when that is the case. Without Premium the 90% alert on Now
  is unchanged and offers the stop. `GET /v1/window-stop`,
  `settings.window_stop_pct`.
- **Today, at the top of the sidebar.** Under *New agent*: what every
  agent has spent today, how many agents are running and how many wait on
  you, and the Claude plan's 5-hour and weekly windows as thin bars with
  the share used and when each resets. Click the spend for Cost, a window
  for the plan limits, *Running* for Now, *Waiting* for the session that
  has waited longest. While the sidebar is open the status strip leaves
  the windows and the spend to it.
- **A menu on every project.** The ⋯ on a project's row (on hover, and
  always on the project in front), a right-click, or Shift+F10: hide it
  from the sidebar or show it again, close all its tabs (the sessions and
  shells in them keep running), open its folder in an editor, or remove it
  from Caprock after a confirmation — its files and sessions stay as they
  are.
- **Subagents in the agent cockpit.** While a session's subagents work, the
  cockpit lists them under *Subagents · N*: each one's type and the task it
  was given, its current call and how long it has run, how many calls it
  has made, and *waiting on you* while it has a prompt open; those that
  finished in the last half hour are one line. The daemon sums them up
  (`GET /v1/sessions/{id}/subagents`), so thousands of subagent events never
  reach the page.

### Changed

- **Project rows say what runs in them.** Each row shows how many agents
  are running there and what the project cost today, beside the waiting
  badge rather than in place of it; a project with neither shows neither.
  The branch takes only the room left over and steps aside, rather than
  showing as a sliver, when too little is left.
- **New agent is outlined, and the sidebar's shortcuts are readable.** The
  New agent button keeps the accent as a 1px border and label on the panel
  instead of a solid fill, and the key hints beside New agent, Add project
  and Dashboard are set at the size of the label next to them.

### Fixed

- **Codex sessions read as a conversation in Chat.** Your own prompts now
  appear beside Codex's replies; before, only the replies did. Each command
  shows the command it ran, not its JSON or JavaScript wrapper. A finished
  call no longer reads "running" forever: it shows its output, and a failed
  one says so, with the exit code where Codex recorded one. Sessions already
  imported get their prompts and outputs once, from the transcripts still on
  disk.
- **The cockpit's tool list was empty on a busy parent.** A session whose
  subagents logged hundreds of calls an hour had none of its own among its
  newest 400 events, so *Recent tools* read "No tool calls yet" and the cost
  spark showed one bar. The cockpit now asks for the main thread's own calls
  and turns (`events?newest=1&main=1&kind=…`).
- **A subagent's permission prompt read as the parent's.** The card, the
  cockpit's Now line, the menu bar popover and the notification now say
  "Subagent (general-purpose) wants to run Bash", lead with what the command
  does (`rm -f $C/*` rather than `C=/pri…`), and show the whole command
  wrapped, folded when long.
- **Approving with several prompts open could answer the wrong one.** When
  subagents ask at once, Caprock cannot tell which dialog the terminal is
  showing. With two or more outstanding, the card lists them all with who
  asks and offers *Open terminal* instead of Yes and No, the daemon refuses
  to type an answer, and notifications carry no Approve. A prompt is now tied
  to its own call, so the call finishing clears it and nothing else.

## [0.91.0] - 2026-10-08

### Changed

- **A New agent button you cannot miss.** The app's sidebar opens with an
  accent *New agent* button (⇧⌘N) and *Add project* (⌘O) under it; the
  small *Add* beside *Projects* is gone.
- **A shorter project list.** Projects with nothing running and no activity
  for a week fold under *Quiet* at the bottom of the sidebar, and any
  project can be hidden from its row (the crossed eye) into *Hidden* and
  brought back from there. Both groups start closed and remember being
  opened. A project with something running or waiting, or the one in
  front, always shows.

## [0.90.0] - 2026-10-08

### Added

- **The agent cockpit.** The panel beside an agent's terminal now shows
  what only Caprock knows, live: the agent's character in its state, what
  the session has cost and what each of its last model calls cost, the
  context bar and what every call pays to re-read it, the tool call
  running this second and for how long, the last seven calls with their
  durations, the uncommitted changes, the plan windows and a loop warning
  when there is one. It is open by default; ⌘I closes it, and closed is
  remembered. An agent that does not report a figure (OpenCode's plan, a
  context before the first answer) shows nothing there rather than a zero.

## [0.89.0] - 2026-10-08

### Changed

- **Adding a project is easier to find and to finish.** The sidebar says
  *Add* beside *Projects* instead of showing a lone folder icon. Pasting a
  repository URL fills the destination the way `git clone` names it; a
  destination whose folders do not exist yet is made rather than refused,
  and `~` works in any path. A new *First task* field starts an agent on
  the project once it is added — the instructions field, which only shapes
  later sessions, now sits behind a link so it is not mistaken for one.
- **The Premium dialog opens the right page.** "Read more" lands on the
  feature you were reading about on caprock.dev/premium, and the buy
  buttons tell the checkout which feature they came from — the feature's
  name only, nothing about you.

## [0.88.1] - 2026-10-08

### Fixed

- **`?agent=deepseek` on the stats endpoints is no longer a 400.** The
  DeepSeek filter the dashboard offers was refused by the API, which accepted
  only claude, opencode, gemini and codex.

## [0.88.0] - 2026-10-08

### Added

- **Claude Haiku 5.5 is priced and can be picked.** The pricing table gains
  it at Anthropic's list price (read 2026-10-08) — its turns were unpriced
  until now — and New agent offers it in place of Haiku 4.5 after it answered
  the real `claude`. Anthropic charges more for a prompt over 100,000 tokens;
  the table carries the lower tier, so such prompts are under-reported, as
  the note in the table says.

## [0.87.0] - 2026-10-08

### Added

- **Keyboard shortcuts in the palette.** ⌘K → *Keyboard shortcuts* lists
  every key the app answers to.

### Fixed

- **A session put down days ago is no longer "Waiting for you" on Now.**
  Past 12 hours the banner goes, as the sidebar already folds it.
- **The inspector cuts a long folder path from the left**, keeping the end
  that tells two worktrees apart.
- **Linux notifications behave like the macOS ones.** Checked against the
  released app on dunst and XFCE: Approve, Deny and a click already worked;
  three things did not. An approval now stays until it is answered (it
  vanished after about ten seconds, its buttons with it); one answered
  elsewhere, or by its own button, is taken down, and none is left up when
  the app quits (a press there did nothing), without leaving a blank
  notification in its place; and *Open* shows once (XFCE drew it twice).

## [0.86.1] - 2026-10-08

### Fixed

- **What Claude Code writes to itself no longer shows as your message in
  Chat.** A background task finishing, a reminder or a slash command's
  output arrived as a user turn of raw XML, a screen long; it is now one
  quiet line (the task's own summary), with the full text a click away.

## [0.86.0] - 2026-10-08

### Added

- **The palette finds past sessions.** ⌘K searches every session the daemon
  knows as you type and lists matches under *History* with project, age and
  cost; before, it saw only what was running and offered to start a new
  agent on the words instead.

### Changed

- **A past session in the app opens on its chat, with one way back in.**
  *Resume in a tab* is the page's button, the permission mode beside it;
  *Continue in…*, *Open in* your terminal and the resume command moved under
  *More*. It opened on the raw timeline, with five controls in a row.

## [0.85.0] - 2026-10-08

### Added

- **Recent sessions on a project's empty screen.** With no tab open, a
  project now lists its last six agent sessions with cost and age, and one
  click on *Continue* carries an ended one on in a new tab. Before, the
  sidebar showed only what was running and yesterday's session took the
  dashboard and a session page to reach.
- **Settings from anywhere in the app.** ⌘, opens it, a button sits beside
  *Dashboard*, and the palette finds it by what is in it (permission mode,
  theme, terminal, notifications, phone), along with the dashboard's
  screens by name. In the app, Settings leads with how new agents start,
  appearance, terminal and editor; the phone and Telegram follow.

### Fixed

- **A worktree started from New agent no longer shows up as a change in
  the main checkout.** `.caprock-worktrees/` was listed as untracked there,
  and *Commit all* would have committed it.
- **A new worktree needs no name.** Left empty, it is named after the first
  message; a name with characters the daemon refuses is said beside the
  field, not in a clipped line in the footer.
- **Waiting on you is about now.** A turn that ended more than 12 hours ago
  folds under *Older* and stops counting in the badge, the project's count
  and ⌘J, so the session that just finished is not behind one from last
  week.
- **⌘T opens the shell in the folder of the tab in front** — its worktree —
  not the project's root.
- **A tab is named after its agent**, with *+N* for its split panes; it read
  "shell" as soon as a shell was split beside it.
- **The dashboard in the app drops what the window already shows**: the
  website footer, a second link state, theme switch and version.
- **"1 changed file"**, not "1 changed files".
- **A long branch no longer hides the project's name** in the sidebar: the
  branch gives way first.

## [0.84.1] - 2026-10-08

### Fixed

- **Permission card buttons work after a restart and with agents in the
  background.** The card read the dialog off a replay of the session's
  recent output, which after a restart could start mid-screen and hide it;
  every button then said *not on the prompt*. It now also reads the dialog
  from what was drawn after the prompt arrived, and allows the extra rows a
  status line and background agents add under it.
- **A terminal reopened after a restart draws its whole screen.** Reattaching
  to a running Claude Code session could leave its status rows as bare
  numbers, their labels lost from the replay. The first size a terminal
  sends now makes the session redraw everything.

## [0.84.0] - 2026-10-08

### Changed

- **A new install asks before running commands.** With no saved preference,
  new sessions start in *Accept edits · asks first* rather than bypass. Bypass
  is one pick away in the New agent sheet, and the mode you pick there is
  kept for the next agent. If you relied on the old default, pick bypass once.

## [0.83.0] - 2026-10-08

### Added

- **Notifications on Linux open the session and answer prompts.** A click
  on a notification used to do nothing there. It now opens the session, and
  a permission request carries Approve and Deny where the desktop's
  notification server shows actions.

### Changed

- **The dashboard header says only *caprock*.** The *mission control*
  tagline from before the desktop app is gone.
- Built with the modernc.org/sqlite 1.60 driver, and the dashboard with
  Vite 8.3.2. No change in behaviour.

## [0.82.0] - 2026-10-07

### Added

- **Project instructions reach Codex too.** A Codex session started in a
  project gets its instructions as Codex's developer instructions, beside
  the repository's own `AGENTS.md`.

### Fixed

- **Opening the dashboard no longer asks for Documents or Downloads.** The
  per-repository cost panel ran `git` in the folder of every session with
  spend, so a session once run in `~/Documents` or `~/Downloads` made macOS
  ask for that folder after each update. Folders macOS guards are left alone
  until you open the session itself.
- **The menu bar says what its number counts.** It showed a bare *2*; it
  now reads *2 waiting*. The Dock badge stays a number.

## [0.81.0] - 2026-10-07

### Added

- **Project instructions.** A project can carry instructions for its
  agents — set them as you add it, or from the New agent sheet — and every
  Claude Code session started in it gets them appended to its system prompt.

### Fixed

- **`/exit` leaves one shell, however many windows show it.** When a
  session's tab was open in the app and in a browser (or on a phone), each
  window started its own shell in its place, and the project listed two.
  They now share one.
- **A screenshot dragged from its thumbnail reaches the session.** macOS
  keeps the corner thumbnail in a folder only the app it is dropped on may
  read, so Claude answered "operation not permitted". The app now copies
  such a file into Caprock's paste folder and types that path.
- **The permission card on a phone names no keys.** On the session screen,
  where there is no terminal, it said *Keys work from the terminal* and drew
  Y and N on its buttons. It now shows the buttons alone there.
- **A permission card whose question is gone can be closed.** When Claude
  Code's request timed out or a check denied it, the card stayed until the
  turn ended and its buttons said *that option is not on the prompt*. A
  button now takes such a card away, and **×** hides any card without
  typing anything.
- **The Dock badge counts everything waiting on you.** It counted
  permission prompts only, so an agent that finished and waited for your
  answer left the Dock bare. It now shows the popover's *Needs you*. The
  menu bar shows the same number beside the icon, instead of an unlabelled
  5-hour percentage; a plan window appears there, named, once it is 80% full.

## [0.80.0] - 2026-10-07

### Added

- **The desktop app updates itself in one click.** When a newer Caprock is
  out, the status strip says **Update to vX.Y.Z — Restart**: it downloads
  the new app with a progress bar while you work, checks its signature,
  installs it and restarts, and everything comes back as it was: every
  session still running (the app moves its own daemon onto the new version
  without ending them), the same tabs in the same order, splits and their
  sizes, the sidebar, the window, each terminal scrolled where you left it
  and anything half typed into an agent. Nothing installs unless it is signed with Caprock's release key for
  that exact version. On its first launch the app asks once whether to check
  for updates automatically (the same release check as Settings → Privacy,
  off unless you say yes); **Check for Updates…** in the app and tray menus
  and in the command palette works either way. The macOS app, the Windows
  installer and the Linux AppImage update themselves; `.deb` and `.rpm`
  installs are told to use their package manager. Each release now carries
  `latest.json` and the signed update files.
- **A newer version announces itself in the corner.** A card at the bottom
  right of the app says *Caprock vX.Y.Z is available* once per version, with
  **Update and restart**, *What's new* and **Later**, and shows the
  download's progress; the status strip keeps its line.
- **View → Reload (⌘R) in the Mac app; F5 on Windows and Linux.** Ctrl+R is
  left to the shell's history search, and F5 in a focused terminal still
  reaches the program in it.

### Fixed

- **The app no longer keeps the old UI after an upgrade.** After `brew
  upgrade --cask`, the app loaded its window from the previous daemon, then
  replaced that daemon with the new one and never reloaded: the window ran
  the old version's code, and the status strip named it, until the app was
  quit. The app now decides to replace its daemon before loading any page,
  and reloads the window and the menu bar popover if a replacement still
  happens under them.
- **A page reloads itself when its daemon is updated.** The daemon names its
  version in the page it serves; when the live link comes back to a
  different one, the page reloads on the same screen — in the app, a
  browser tab or a paired phone. Typed terminal input is kept (it lives in
  the session). With text typed into an open sheet it offers *Reload —
  Caprock was updated* instead, and it never reloads twice for one version.
- **A command that finishes fast keeps its last lines.** Caprock closed a
  terminal the moment its process exited, so the final output of a short
  command could be lost (seen on Linux). It now reads the terminal to the
  end first, waiting at most two seconds.

## [0.79.0] - 2026-10-07

### Added

- **One consent for bypass, in Caprock.** The first bypass session on a
  computer used to open on Claude Code's own warning, where Enter means
  *No, exit* and drops you into a shell. The New agent sheet and the New
  session dialog now show what bypass means and start with *Accept and
  start*, which answers that warning for good. A bypass start without it is
  refused by the daemon rather than left on that screen.

- **Start an agent without the mouse.** In the New agent sheet ↑ and ↓
  change a choice in place instead of opening its list, ⌘↩ starts from
  anywhere in the sheet (a list or a button too, not only the message), and
  the footer names the keys: Tab moves, ↑↓ change, ⌘↩ starts, Esc cancels.
  The dashboard's New session dialog takes the same arrows.

### Changed

- **The permission card is back under the terminal, and answers from it.**
  0.78.2 hid it while the session's terminal was in front. It shows again,
  and with focus in that terminal **Y**, **A** ("don't ask again") and **N**
  answer it without reaching the terminal; Enter and Esc stay with Claude
  Code's own menu. Each button names its key.

- **New sessions start on bypass.** With no saved preference, the New session
  dialog and the New agent sheet open on *Bypass · never asks* instead of
  *Accept edits*. Settings → New sessions still overrides it, and a bypass
  start from a paired phone is still confirmed.

### Fixed

- **The model list names the model you get.** It offered "Opus 5" while
  Opus 5.5 was out, and picking it started the older model. The list is now
  Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5, each label with its exact
  version, opening on Opus 5.5; a newer model in the pricing table that the
  list does not offer fails the build.

- **"Bypass · never asks" is spawned the way Caprock's own unattended
  workers are,** with `--dangerously-skip-permissions`. (Claude Code treats
  it as the same mode as `--permission-mode bypassPermissions`; an earlier
  version of this entry said the latter keeps asking. The questions came
  from `permissions.blockReadsOutsideWorkingDirectories`, below.)
- **Caprock's own files are not a question.** Claude Code sessions start with
  `--add-dir` for the directories Caprock writes to (pasted screenshots and
  quick chats), so a user with
  `permissions.blockReadsOutsideWorkingDirectories` on is no longer asked
  about files Caprock put there itself. That setting is a perimeter no
  permission mode lifts; a run meant to be unattended needs it off.
- **A session that exits leaves a shell, not a dead tab.** After `/exit`, the
  tab becomes a shell in the same folder, keeping its place in the tab strip
  and in a split. Before, the process was gone and the tab kept showing its
  last screen.
- The pricing check against the site no longer breaks when the site's pricing
  file grows a team price: it reads the personal plans only.

## [0.78.2] - 2026-10-06

### Added

- **Settings → New sessions: the permission mode new agents start in.** The
  New session dialog and the New agent sheet open on it, and a session started
  without choosing one (the project terminal's "New session here", a quick
  chat) starts in it. Unset, nothing changes.
- **`make app-local`: try a change to the Mac app without a release.** It
  builds this checkout's app for the Mac's own architecture, installs it over
  `/Applications/Caprock.app` and relaunches it; the app then moves the daemon
  onto the build it carries, and running sessions carry on. Stamped
  `<last tag>-dev+<commit>`, which About Caprock shows and the update notice
  does not mistake for an old release. About half a minute once the build
  cache is warm. `make app-local-revert` goes back to the released app.

### Changed

- **One permission question in the app, not two.** When a session's terminal
  is in front, its own "Do you want to proceed?" menu is where you answer —
  press Enter — and Caprock no longer draws its approval card above the
  status strip for it. The card still shows when the chat or a Changes view
  covers the terminal, and now says *↵ Enter in the terminal = Yes*; other
  tabs' prompts still reach you through the Inbox, the menu bar, the
  notification and the phone.
- **Keys on the permission card.** `Y` or Enter is Yes, `A` the "don't ask
  again" option when there is one, `N` or Esc is No, shown on the buttons.
  They never fire while you are typing in the terminal or a field.

### Fixed

- **"Yes, for the rest of this session" no longer rejects the call.** The
  button typed `2`, assuming Claude Code's usual menu; in auto mode the
  dialog is "1. Yes 2. No", so it answered No and the tool call was lost.
  Every permission button now reads the menu on the session's screen and
  presses the option whose text matches; when that option is not there, it
  types nothing and the card says *that option is not on the prompt — answer
  in the terminal*.
- **A permission card answers the dialog it shows.** Each new permission
  request (a subagent's too) replaced the last, so a card could name one
  request while its key landed in another's dialog. Requests now queue the
  way Claude Code queues them: the card shows the oldest, says how many more
  wait, and a later request never overwrites an earlier one.

- **Upgrading the Mac app now upgrades its daemon too.** An app started on a
  new release kept the daemon of its own from the old one running until that
  was too old to talk to. It now puts the daemon it carries in place once per
  launch when the two differ; sessions keep running.
- **Quitting the app with SIGTERM** (`kill`, a script) now quits it the way
  Cmd+Q does, keeping the window's size and place.
- **A live session's Changes tab no longer flashes "loading…" on every
  event.** Each new event re-read the diff as if it were a new question,
  blanking the list and drawing new rows, so a click on a file or on "expand
  all" in that moment was lost. The list now stays on screen while it is
  read again.
- **App shortcuts act on what is on screen.** A key pressed in the instant
  after the sidebar updated could act on the state before it: ⌘J said nothing
  was waiting with a waiting session in the list, and ⌘T asked to add a
  project with one already there.
- **The app's status strip shows the daemon's real version.** It was read
  once when the page loaded, so after the app swapped its daemon it kept the
  old number. It is now read again whenever the live link reconnects and when
  the window regains focus.
- **Continuing a session keeps the permission mode it was running in.** A
  session run with permissions skipped (`--dangerously-skip-permissions`)
  came back from "continue here" or "branch here" in the default mode, asking
  before every command. Caprock now continues it in the mode its hooks last
  reported — bypass, accept edits, plan — and says which beside the button,
  where it can be changed before continuing. A session with no recorded mode
  uses the setting under Added above.

## [0.78.1] - 2026-10-06

### Added

- **Download links for the desktop app that never change.** Every release now
  also carries the app under names without the version — `Caprock-macOS.dmg`,
  `Caprock-Windows-setup.exe`, `Caprock-Linux.AppImage`, `Caprock-Linux.deb`
  and `Caprock-Linux.rpm` — so
  `https://github.com/dspv/caprock/releases/latest/download/Caprock-macOS.dmg`
  always fetches the newest build. The versioned files stay, and
  `checksums.txt` lists both. A release is marked Latest only once all of
  them are attached, so a link never points at a release still being built.

### Changed

- **Terminal defaults follow the JetBrains IDE terminal:** JetBrains Mono at
  13 px, line height 1.2 (was 1.15), Regular and Bold weights. Terminal settings
  you already saved are kept as they are.

### Fixed

- **The terminal's font looks like JetBrains Mono again, in every glyph.** In
  the macOS app, digits, capitals and punctuation came out heavier and
  brighter than the letters beside them, at random, for as long as the
  terminal was open: the WebGL renderer drew some glyphs outside the page and
  some inside it, and WebKit rendered the two differently. Every glyph is now
  drawn the same way. The app terminal also asks for every part of the face
  (Latin, Cyrillic, Greek, Vietnamese; regular and bold) before it opens,
  instead of measuring whatever had loaded, and measures and redraws itself
  when a face finishes loading. Ligatures are off in every terminal, so `=>`
  and `!==` show the characters that were typed.
- **A permission prompt survives a daemon crash, not only a restart.** The
  prompt an owned session was waiting on was stored in the background after
  the hook that drew it had been answered, so a daemon killed in that moment
  — a crash, or any stop on Windows, which has no graceful one — came back
  with the dialog still on the session's screen and no buttons to answer it.
  The prompt is now stored before the hook is answered.

- **Dropping a file on a terminal in the desktop app works.** The app's
  native drag-and-drop handler took every drop, so a file dragged from
  Finder onto a session did nothing. The app now types the file's real path,
  quoted, into the terminal under the pointer, as a terminal does: nothing is
  uploaded, any file or folder goes, and Claude works on the original rather
  than a copy. In a browser a drop still uploads, as before. Tabs in the
  app's tab strip reorder by dragging again (they could not while the native
  handler was on).
- **macOS: one "caprock" in Privacy & Security, not one per release.** The
  Homebrew daemon runs from a new Cellar path every release, and macOS
  lists every path as another program; agent sessions ask for folder access
  in the daemon's name. The app now runs its own daemon from one path in the
  data directory and moves a running Homebrew daemon onto it once (unless
  the Homebrew one is newer; `"own_daemon": false` in `app.json` keeps it).
  Sessions keep running through the move. Each release still asks once
  until Caprock is signed with a Developer ID. [ADR-040](.ai/08-decisions.md)
- **The app no longer aborts when the daemon stops while the menu bar
  popover is still loading its first page.** It asked the WebView for its
  URL, which a page that never committed does not have, and wry unwraps it
  on the main thread.
- **Test, bench and preview daemons stay out of Desktop, Documents and
  Downloads.** A daemon running with a temporary HOME no longer watches or
  runs `git` in those folders of the real account, even with a copy of the
  real database, so it never raises a privacy prompt; the bench stand
  refuses to live there.

## [0.78.0] - 2026-10-06

### Added

- **GitHub in the app (F14).** Settings → GitHub connects your account with
  your GitHub CLI login (read when needed, never stored), a pasted token
  (kept in the macOS login keychain, else a file only you can read) or, once
  a Caprock OAuth app is configured, *Sign in with GitHub*. It shows the
  account, scopes and a health line (last success, requests left, the last
  error word for word). ⌘O and the phone's *Start work* list and search
  your repositories to clone. A project with no remote can be put on GitHub
  (private by default). A worktree's Changes view opens a pull request —
  title and description from the commits or the agent's summary, base the
  default branch, draft switch, pushed first when needed — and then shows
  its checks, reviews and mergeability; the sidebar marks worktrees with a
  pull request, green, amber or red. Updates arrive live; GitHub is read at
  most once a minute per repository with conditional requests, and the app
  can notify you when CI fails or a review lands. Phones read all of it; a
  controller phone can open a pull request. Every GitHub error is shown
  with what Caprock was doing. See [docs/app.md § GitHub](docs/app.md#github).
- **A guide to the desktop app.** [docs/app.md](docs/app.md) walks through
  the window — projects, tabs, terminal, chat, inspector, the keys — the
  menu bar, badge and ⌃⌥⌘C, notifications with Approve and Deny (and when
  Approve is offered), pairing a phone over Wi-Fi or Tailscale, and starting
  work from the phone. The README now leads with the app, with a screenshot
  made from demo data; the daemon, the dashboard and the CLI are documented
  as before.
- **Split panes in the app.** ⌘E puts a new shell beside the terminal in
  front, ⇧⌘E below it; ⇧Enter in the palette opens a session there. Each
  pane has a header with its status, the focused one a ring; ⌘[ and ⌘]
  move between them, the divider drags or takes the arrow keys, ⌘W closes
  the pane (the session keeps running). Up to four panes a tab, restored on
  relaunch.
- **Jump to what is waiting.** ⌘J opens the next session waiting on you,
  permission prompts first, and wraps; the palette lists them at the top.
- **A sharper command palette.** Results rank by where they match (start of
  the name, start of a word, anywhere); "New agent in <project>" for every
  project; text that matches nothing starts an agent on it in a new worktree
  named after it, with the text as its first message.
- **Menu bar popover (macOS).** A click on Caprock's menu bar icon opens a
  panel under it: what needs you (approve or deny a prompt shown in full),
  what is running with its cost, today's spend and the Claude and Codex plan
  windows with when they reset. It opens over the app you are in without
  switching to Caprock or raising its window. A right click keeps the menu.
- **Find in the terminal.** ⌘F (Ctrl+Shift+F off macOS) opens a find bar
  over the focused pane: matches highlighted as you type, "3 of 12", match
  case, regular expressions, Enter and ⇧Enter for next and previous. Esc
  closes it and puts you back in the terminal. Works in every pane of a
  split, in agent and shell tabs alike.
- **Open in your editor.** VS Code, Cursor, Zed or a JetBrains IDE, when
  installed: right-click a project or worktree in the sidebar, use the
  palette ("Open <project> in Zed"), or the inspector — the session's
  folder, or a changed file at its first changed line. Settings → Editor
  picks the default. Only from this computer: a paired phone can never open
  an editor on its screen.
- **Terminal colours and fonts.** Settings → Terminal: five palettes
  (Caprock, a light Paper, Catppuccin Mocha, Tokyo Night, Solarized Dark),
  JetBrains Mono or any of SF Mono, Menlo, Fira Code and other monospace
  faces found on the machine, size, line height and cursor shape, with a
  live preview. Every open terminal changes at once; kept per browser.
- **Update notice in the app.** With release checks on, the status strip
  says when a newer Caprock is out and opens to the exact command — `brew
  update && brew upgrade --cask caprock-app` for the app from Homebrew, and
  the daemon's own command when the formula installed it. "Not now" hides
  that version. Nothing installs itself.
- **Review and commit without a terminal.** Click a worktree's ±N in the
  app's sidebar (or *Review and commit* in the inspector, or "Review
  changes" in the palette) for its Changes view: staged, unstaged, new and
  conflicted files; each file's diff unified or side by side, with large
  diffs collapsed until asked and a 5,000-line diff scrolling smoothly;
  stage, unstage and discard files (discarding asks first), stage or
  unstage single hunks; a commit message box that can start from what the
  agent said last; Commit, Commit & Push, Push (a new branch is published
  and tracked; never forced), Pull (fast-forward only) and Fetch. Keys: j/k,
  s, u, d, v, c, r, Esc; ⌘↵ commits, ⇧⌘↵ commits and pushes. Hooks run, and
  a hook that refuses shows what it printed; a remote that refuses your
  credentials says so. On the phone, a session's *Changes* tab gains the
  same commit and push for its worktree (tap files to choose them); a
  view-only phone sees the counts.

### Changed

- **Release checks run at most every 6 hours, and a running daemon keeps
  checking.** They used to run at startup and when switched on, throttled to
  a day, so a daemon left running for a week never heard of a release.
  Repeats are conditional (`If-None-Match`), so an unchanged release costs
  GitHub a 304 and no body. Still off until you turn it on.
- **The app uses less CPU when idle, and stalls less on the first tab.**
  With its window hidden the app checks the daemon every 5 s and the page
  stops polling (the live connection stays); the visible, silent window
  polls less and redraws its clocks only when they change. A terminal
  warms up once after start, and replays are written in slices. Hidden, the
  app now takes about 0.3% of a core (was 1%); the first tab of a launch
  still holds the window for up to 70–130 ms (was 70–150 ms).
- **A half-open connection is caught sooner.** After 20 s without a word
  from the daemon the page pings it and redials if no answer comes within
  2 s (about 22 s, was 25 s).

### Fixed

- **A project's main checkout keeps its own sidebar row beside a linked
  worktree.** With nothing running in either, the project read as one
  checkout named after the linked worktree's branch.
- **The app's status strip rounds plan usage as Now does.** It floored, so
  the same window read 41% there and 42% on Now.

## [0.77.0] - 2026-10-06

### Added

- **Install the desktop app.** Each release now carries the app beside the
  daemon, built from the same tag and bundling that daemon: a universal
  `.dmg` for Apple silicon and Intel Macs and a Homebrew cask
  (`brew install --cask dspv/tap/caprock-app`), an installer for Windows, and
  an AppImage, `.deb` and `.rpm` for Linux. The app is not notarized or
  code-signed yet; the cask opens it without a Gatekeeper prompt, and
  [docs/install-app.md](docs/install-app.md) has the one-time step for the
  `.dmg` and for SmartScreen. On first launch the app starts the `caprock`
  formula's daemon when Homebrew installed one, so `brew upgrade caprock`
  keeps it current, and its own bundled daemon otherwise. A release can now
  add the `.dmg` from a Mac with `make app-release TAG=vX.Y.Z` when Actions is
  down.
- **Start work from the phone.** A phone allowed to control sessions gets
  **Start work** on Now: clone a repository (an `https://` or `git@`
  address, into a folder under your home), make a new project, or make a
  worktree — then **Start an agent here**, which opens on the session's chat.
  A clone runs on the computer and the phone follows it: lose the signal or
  lock the phone mid-clone and the page catches up when it is back, without
  cloning twice. A view-only phone is refused each of these, on the screen and
  by the daemon.
- **Pair over Tailscale by QR.** When the computer is on Wi-Fi and Tailscale,
  Caprock listens on both, and the pairing panel draws the code for the one
  you pick — *Wi-Fi*, *Tailscale* (works on mobile data) or the Tailscale name.
  Without Tailscale it says plainly that a phone off the Wi-Fi cannot reach it.

### Changed

- **The chat on a phone.** Its field now holds a message typed while the
  connection is down ("Will send when connected") and sends it on reconnect
  unless a permission prompt waits, as the terminal's keys bar does; if the
  session ends meanwhile it stays as a draft to edit. Back from a long drop,
  the chat fetches everything it missed instead of starting over at the
  newest page, and what you were reading stays where it was. A short
  conversation sits at the bottom, by the field. On the Chat tab the session
  header is one line and one row of controls, with the rest under
  **Details**, so the conversation starts about 270 px higher at 390 px.
  **Photo** puts the picture's path in the field, to send with your words.

### Fixed

- **The desktop app's terminal no longer cuts off its last rows** a few
  seconds after opening, when it switches to the faster renderer.
- **The terminal no longer covers its own text field on a phone.** Once
  the faster renderer took over, the terminal grew past its box and over
  the field under it; it now fits itself again.

## [0.76.0] - 2026-10-06

### Added

- **The phone never needs a manual reconnect, and says honestly where it
  stands.** The live feed and every terminal share one reconnect policy:
  forever, with full jitter from 0.5 s to a 15 s cap, and at once when the
  page comes back, the browser goes online, or the network changes; a socket
  that looks open after a wake must answer within 2 s or it is replaced, and
  a half-open one is caught within 25 s. The header (and the app's status
  strip, and a pill over the terminal) says *Live* only while the daemon
  answered in the last 25 seconds; otherwise *Catching up…*, *Reconnecting
  (n) · next try in s*, *Offline since hh:mm*, or *Control revoked* with the
  reason. A message sent from the phone's keys bar while offline is held as
  *Will send when connected* and sent on reconnect if no permission prompt
  waits — otherwise it stays as a draft with **Send now**; Esc, arrows,
  Ctrl+C and prompt answers are never queued.
- **Read a session as a chat.** A new Chat tab shows the conversation — your
  prompts, what the agent wrote, each tool call on one line that opens — with
  a field and keys that type into the session. On a phone a session opens on
  it; in the app, an agent tab switches between terminal and chat. Messages
  always appear in the order the session produced them, never twice, however
  late they arrive; scrolled up, nothing moves while new ones come in, and a
  "↓ N new" pill takes you back down.
- **Approve and Deny right in the macOS notification.** A permission prompt's
  notification now carries the buttons: Approve answers that prompt without
  bringing Caprock forward, Deny refuses it, and a click on the notification
  opens the session. Approve is offered only when the notification shows the
  whole request; a longer command offers Open in Caprock and Deny, so you read
  it on the prompt card first. A prompt answered in the meantime is never
  typed into: you get "Already answered" instead, and a prompt answered in
  the terminal or on the card takes its notification away. macOS asks once
  whether Caprock may send notifications. Windows and Linux keep the click
  that opens the prompt.
- **The desktop app tells you when a session needs you.** An OS
  notification names the project and session and what it wants — `Bash: go
  test ./...`, the file an edit would change, the question asked — the moment
  an agent is blocked on a permission prompt. Clicking it opens that session
  with its Yes and No buttons; a prompt answered meanwhile is refused, never
  typed into. Nothing for the session you are already looking at. On by
  default in the app; "finished" notifications are there too, off by default;
  both switch in Settings → Desktop notifications. Same limits as Telegram
  alerts, which stay off unless you turn them on.
- **The live feed replays what you missed.** Every `/v1/live` frame now
  carries a `seq`, and the daemon keeps the last 2,000 frames or 10 minutes.
  A dashboard that drops off — a phone locking, Wi-Fi changing — reconnects
  with `?since=` and receives exactly the frames it missed, in order, so a
  notification sent while it was offline still arrives; when the gap is older
  than that, a `reset` frame makes every screen refetch instead. A socket
  silent for 25 seconds is taken for dead and reconnected, as the terminal
  already does. Clients that predate this keep working unchanged.
- **Menu bar, badge and a global hotkey in the desktop app.** The menu bar
  (a tray on Windows and Linux) shows the 5-hour and 7-day plan usage for
  Claude and Codex, today's spend and the sessions waiting for your
  approval; click one to open it. The Dock badge counts them and clears
  when none wait. ⌃⌥⌘C (Win+Alt+C on Windows and Linux) brings the window
  up from any app, changed or turned off in Settings → Global shortcut;
  Wayland does not allow global shortcuts. On macOS closing the window now
  keeps Caprock in the menu bar.

### Fixed

- **Paging back through a session no longer skips events.** Events sharing a
  millisecond with the oldest one shown were left out of the page before it.

## [0.75.0] - 2026-10-05

### Added

- **A terminal-first workspace for the desktop app,** at `#/app` (or `?app=1`).
  A sidebar with what is waiting on you, then every project with its
  worktrees, sessions and shells, today's cost and status dots; terminal tabs
  per project that survive a relaunch; an inspector with cost, context,
  tokens, the permission prompt and the uncommitted changes; a status strip
  with the plan limits and today's spend. ⌘T a shell, ⇧⌘N an agent, ⌘O a
  project, ⌘1–9 tabs, ⌘W closes a tab without stopping its session, ⌘K a
  command palette. The dashboard opens inside it. Sessions in folders that are
  not a listed repository sit under *Other folders*; ⌘O clones with git's
  progress shown. The browser dashboard and the phone are unchanged.
- **Projects in the daemon.** Caprock keeps a list of the projects you work
  in — seeded from the repositories your sessions ran in, plus any you add,
  create (`git init` optional) or clone — with each one's branch, changed
  files, ahead/behind, worktrees, live and waiting sessions and today's cost
  (`GET /v1/projects`). Git state follows a commit or checkout made anywhere
  within about a third of a second, by watching `.git`; idle projects run no
  git at all. A clone shows git's progress and carries on if the phone that
  started it drops. Unlisting a project never touches its files. The desktop
  app's sidebar shows it.
- **Worktrees on any branch.** A worktree for an existing branch, a new one,
  or a branch only the remote has (created tracking it), under
  `.caprock-worktrees`; one with any change is never removed.
- **Shell tabs, engine side.** `POST /v1/shells` starts your login shell in a
  project, held like an agent session so it survives a Caprock restart. A
  shell is in no total, card or count.
- **From the phone**, a controller can add, create and clone a project under
  home and make or remove a worktree. Shells stay on the machine for now.
- **`api_level` in `GET /v1/status` and `runtime.json`**, an integer raised by
  every API change a client must know about, so the desktop app (and later a
  bundled UI) can tell whether a daemon is new enough without parsing its
  version. `runtime.json` also records the daemon's executable path.
- **`CAPROCK_SERVICE_LABEL`** runs `caprock service install|uninstall|status`
  under another label, so a second, isolated install (a preview, a test) never
  touches the real `dev.caprock.daemon` login agent.
- **The desktop app's shell** in `app/` (Tauri v2): it finds or starts the
  daemon and opens its dashboard in a native window. Built and tested in CI on
  macOS, Windows and Linux; `make app` runs it from a checkout.

### Changed

- **Phone alerts are off until you switch them on.** A Telegram bot saved for
  the weekly report started sending alerts by itself; now *Settings → Phone
  alerts* turns each kind on.
- **A terminal comes back from a dropped connection exactly where it was.**
  When Caprock restarts, the network drops or a phone wakes, the terminal now
  picks up from the last byte it had instead of clearing and repainting, so
  what you scrolled back to stays put, and whatever you typed meanwhile is
  sent once it reconnects — never lost, never typed twice, even across a
  Caprock restart. It keeps trying for as long as it takes (it used to give
  up after a minute and ask for a reload), and a pill over the terminal says
  *Reconnecting — your keys will be sent* instead of a line written into it.
  Up to 4 KB of typing is kept while offline.

- **Lists no longer jump while you read them.** Scrolled down the session
  timeline or the live activity feed, new rows arriving above keep your place,
  in Safari as in Chrome, and a pill says how many arrived.

- **Session cards tell same-named folders apart and say ended when ended.**
  Two folders both called `caprock` now read *Downloads/caprock* and
  *dev/caprock* — the shortest path that tells them apart — on Now, the pulse
  and the app sidebar; the card leads with the session's title or first
  prompt, the short id after it. A folder that is not a repository, or a
  detached checkout, no longer shows `HEAD` as its branch. A session the
  daemon lists as ended never shows as idle.

### Fixed

- **Gemini CLI is no longer labelled "your own key" in the agent picker.**
  It also signs in with Google, so the note was wrong for most people.

## [0.74.0] - 2026-10-05

### Changed

- **Phone alerts say which session and what it did.** The first line, the one
  a lock screen shows, is what happened and the session's title —
  *✅ Finished · Fix the cache test*, *⏳ Needs approval · …*. Then the folder
  as `~/dev/caprock` (not just `caprock`) and the branch; for a dialog, the
  tool and the command or file it asks about; for a finished run, how long it
  worked since your last prompt, what it cost, its tool calls and the files it
  changed. A turn that stopped on an error (a rate limit, an overload) now
  alerts too and says why. Settings → *Phone alerts* has a new switch,
  *Include the last reply's first line*, on by default. Telegram can read all
  of it; code and tool output are never sent (ADR-036, amended).

## [0.73.1] - 2026-10-05

### Security

- **A tunnel on the Mac no longer hands out the owner's rights.** Caprock
  trusted any request that reached it over 127.0.0.1, so cloudflared, ngrok,
  Caddy, `tailscale serve` or `ssh -R` running on the machine let anyone who
  reached the tunnel read everything and start commands, with no pairing. A
  loopback request that carries a proxy header (`X-Forwarded-*`, `Forwarded`,
  `Via`, `X-Real-IP`, `CF-*`, `Tailscale-*`, `Ngrok-*`, …) or names a host other
  than localhost or a loopback address is now treated as a device: it needs a
  paired device's token and gets that device's role, and without one it gets
  `401` — on the API and on both WebSockets. The CLI, the hook shim, the
  statusline, the dashboard and an `ssh -L` forward are unchanged.

## [0.73.0] - 2026-10-05

### Added

- **Remove a session from Caprock.** *Remove from Caprock* on a session's page
  (on the machine, never on a paired phone) takes the session, its events and
  its cost out of Recent projects, every total, Week, Lifetime and exports,
  after a confirm that names the cost. `caprock sessions rm <id>` or
  `--cwd-prefix <dir>` does the same in bulk; it only lists what it would
  remove until you add `--yes`. A removed session is never read back in from
  its transcript. A session still running is skipped. It cannot be undone.
- **Review a session's changes on the phone.** The session page's *Changes*
  tab has 44px file rows, an open file's name stays pinned at the top while its
  diff scrolls, *next* moves to the following file, and lines wrap on a phone
  (*wrap* switches it; a desktop scrolls them sideways inside the diff, never
  the page). Added and removed lines are tinted in both themes, line numbers
  take one narrow column on a phone and two on a desktop, and a big diff is
  drawn 400 lines at a time with very long lines cut until asked for. From a
  phone that controls sessions, tap a line and *Ask the agent* opens the
  terminal with "In <file> around line N: " already typed.
- **A roomier phone terminal input.** The field under a phone's terminal is
  full width and grows with what you type (up to five lines, then scrolls),
  with Photo and Send beneath it; the Esc/Tab/arrow/Ctrl+C keys sit in two
  rows of three so their labels fit at 320px.

### Fixed

- **A permission prompt's buttons survive a Caprock restart.** A session
  Caprock started keeps running through an upgrade, and so does the dialog on
  its screen; its **Yes** / **No** buttons now come back with it instead of
  waiting for the next prompt. A prompt that was answered meanwhile does not
  come back.

## [0.72.0] - 2026-10-05

### Added

- **Answer Claude Code's permission prompts with a button.** When a session
  you started in Caprock asks before running a command or editing a file, its
  page shows the command or file with **Yes**, Claude Code's own second option
  (*don't ask again*, *allow all edits this session*) and **No** — on the phone
  and on the machine. Claude Code sessions only; Codex and OpenCode prompts
  are still answered from the keys bar. Uses a new hook, so the dashboard asks
  once to install it.
- **Attach a photo from the phone.** *Photo* beside the phone's terminal input
  takes a picture or picks one from the library, shrinks it to 2048 px and
  types its path into the session.
- **Phone alerts through your own Telegram bot, free.** Settings → *Phone
  alerts* sends a message when a session is waiting for approval (at once) or
  has finished (after a minute with nothing new) — every Claude Code session on
  the machine, each kind with its own switch, both on once a bot is set up. A
  message names the project, what happened and the agent, with a link to the
  session when phone access is on; never code, prompts, replies, file names or
  commands. One message per question, at most one of a kind per session every
  three minutes and 20 an hour. *Send a test alert* checks the bot. The bot is
  set up in Settings now, so it no longer needs the weekly report's licence.
- **Now says when a session is waiting for approval.** A session at a
  permission dialog — any session, not only Caprock's — reads *waiting for
  approval* with the call it asks about and the *waiting on you* badge, instead
  of looking busy.
- **Caprock on your phone's home screen.** Add it from Safari or Chrome and it
  opens full-screen with its own icon, in your theme, clear of the notch and
  the home bar. On an iPhone the home-screen app pairs once more — type the
  code, since a scan opens Safari — and shows up as "iPhone · home screen".

### Fixed

- **A paired phone opens Week, At a glance and the tool drill-down.** They
  were left out of what a paired device may read and answered 403; the drill's
  Premium half stays gated as on the machine.
- **"Hooks need an update" when only some are missing.** After an upgrade adds
  a hook event, Now said *Hooks not installed* for one missing event; it now
  says the hooks need an update, with an *Update hooks* button.
- **Codex edits count as edits in *What it went on*.** Codex runs its tools
  through one `exec` wrapper, so every patch it applied counted as a command.
  Each call is now placed by the tool it actually ran — a patch is an edit, a
  web search is web — including calls already stored. On one machine 30-day
  editing went from 0.4% to 4.8% of spend. The Tools drill-down for `exec`
  groups by the command or tool inside the script instead of showing almost
  every call as `const`.
- **`caprock service install` no longer leaves the daemon stopped on macOS.**
  It booted the old service out and bootstrapped the new one at once; launchd
  was still tearing the old one down, the bootstrap failed with "5:
  Input/output error", and nothing was running. It now waits for the old one
  to go and retries briefly.
- **"/" is no longer offered as a recent project.** The New session picker
  leaves out the filesystem root, your home directory and the temp directory
  itself, so something on the machine running `claude` from "/" every few
  minutes no longer sits at the top of the list. Folders inside them are
  offered as before.
- **No more "handoff lookup failed … context canceled" in the log.** A session
  opening in "/", your home directory or the temp directory gets no handoff
  and runs no lookup. The lookup itself now skips other projects' passages on
  the index instead of reading each one: a project with nothing to hand over
  took 4-6 s on a 1.2 GB database, longer than Claude Code waits for the hook,
  and now takes under 0.1 s.
- **The share dialog's all-time card is ready when you open it.** The daemon
  works out the all-time and 30-day Weeks when it starts, and reads the tool
  calls behind them in parallel slices: all time went from 5.0 s to 1.9 s on a
  copy of a 1.2 GB database, with the same figures.
- **A long command no longer pushes a session page sideways on a phone.**
  *waiting for approval — running `…`* (or *running `…`*) with a long
  unbroken path or file name was wider than a 320–360 px screen, so the whole
  page scrolled sideways. It now wraps.

## [0.71.0] - 2026-10-04

### Added

- **Your phone as a controller.** In settings, *Let it control sessions* beside
  a paired phone lets it start a session in any folder under your home
  directory — browse to it, or make a new one — picking Claude Code, Codex or
  OpenCode and any permission mode, type into it, answer approvals and stop it.
  Bypass asks once on the phone before it starts. The terminal on a phone has a
  large input field and Esc, Tab, ↑, ↓, Enter and Ctrl+C buttons. *Take control
  away* is one button and holds at once, even on a terminal already open.
  Phones stay view-only until you choose; settings and pairing stay on the
  machine, and so do custom commands and folders outside home. It works over
  your Wi-Fi or Tailscale, with no relay.
  The paired-devices list tells two phones of one model apart by browser, id
  and when each was paired.

### Fixed

- **OpenCode tool calls keep their input.** A bash call's command, a fetch's
  URL, a search's pattern and an edit's strings were not stored, so every
  OpenCode bash call in the Tools drill-down read "(input not recorded)". They
  are stored now, in Claude Code's spelling, and calls already imported are
  filled in from OpenCode's own database the first time Caprock starts.
- **A worker with unread mail is kept working again.** The Stop hook's
  "process your inbox first" answer was nested where Claude Code ignores it,
  so sessions stopped with mail still waiting. It is now in the shape Claude
  Code acts on.
- **Now and a session's page fit a 390px phone.** Banners, the Today panel's
  agent switch, the breakdown bars, the donut legends and the session header
  ran past the right edge and dragged the whole page sideways.
- **"What it went on" counts tool calls again.** Most tool calls were never
  matched to the turn that paid for them, so their cost showed as "no tool
  call" (93% of 30-day spend on the owner's machine). With hooks installed,
  Claude Code's message id was dropped along with the transcript's copy of a
  call the hook had already stored. Codex and DeepSeek calls were never
  linked at all. All three are linked now, and calls already stored are
  repaired the first time Caprock starts: on a copy of the owner's database,
  unmatched calls went from 31,275 to 7 and "no tool call" from 93% to 5%.
  Codex's and DeepSeek's own tool names (exec, js, apply_patch, bash, read,
  edit…) are now counted as commands, edits and reads instead of "other".

## [0.70.1] - 2026-10-04

### Added

- **Install hooks from the dashboard.** The "Hooks not installed" banner on
  Now has an **Install hooks** button that does what `caprock hooks install`
  does and then says what changed: sessions started from now on report live;
  ones already running keep their hooks until restarted. It names the
  settings file it checked, and it can be dismissed until the missing set
  changes.
- **Open a Live pulse row in place.** Clicking a project's row shows today's
  cost and tokens for it, every live session in it with agent, model, state
  and what it is doing, and the terminal, Open repo and Open session buttons.
  Open rows are remembered.

### Changed

- **Settings is plain now, and opening Caprock on your phone is three steps.**
  The screen behind the header's link (now called **settings**) is short
  sections with plain titles: Open Caprock on your phone, Plan & licence,
  Appearance, Privacy, Memory between sessions, Storage, About this install.
  Each option says in one line what happens when it is on.
  - **Phone:** one button, **Show a code**, turns network access on and shows a
    QR code with the six digits in big type beside it. Scan it with the
    phone's camera and the phone pairs by itself, then appears in the list
    with a **Remove** button. The corner says the state at a glance — Off,
    Waiting for your phone…, 1 phone connected. The QR code is drawn in the
    browser; nothing is sent anywhere to render it. **Cancel** withdraws the
    code on the machine, not just from the screen. Phones paired before stay
    listed while network access is off and can be removed then too.
  - **Plan:** set it right there — the same choices as the header's picker.
  - **Theme:** Dark or Light, and Paper or White, from Appearance; the header
    toggle and this control stay in step.
  - **Memory:** the setting says what Claude is handed; the "measure whether
    it helps" experiment is under **Experiments**.
  - **Storage** and the install's own figures keep their detail one click
    down, under **Details**.
- **The header wraps on a phone.** It was one row 882px wide, so every screen
  on a paired phone scrolled sideways.

- **Plan limits read at a glance.** The ring's filled arc is what is used,
  coloured by level, on an empty neutral track; a forecast is one plain
  sentence — "At this pace you'll hit 100% around 19:10 — about 1 h before it
  resets." — amber unless it is under half an hour away, not a red dashed
  ring. The explainer is one line, with the details behind "more".
- **Agents are easier to read.** At a glance's agent tiles are bigger and
  their ring says "of spend"; the Live pulse row shows its state as a
  coloured pill and its agents as "4 agents" with the model at full
  contrast.

- **A session you start in Caprock survives Caprock restarting.** Upgrading
  Caprock, `launchctl kickstart`, `caprock down` and `up`: each used to end the
  sessions started from the dashboard. Each session's terminal now lives in a
  small process of its own (`caprock pty-host`), and the restarted Caprock
  picks it back up — the terminal shows what was on screen and takes typing
  again, and stop, pause and kill work as before. `caprock down` stops
  Caprock, not your sessions; end a session from its page or by exiting it.
  **Sessions started by an earlier release are still ended by the upgrade that
  installs this one**: their terminal is inside the old Caprock process.
- **Autostart keeps sessions alive across service restarts.** The launchd agent
  sets `AbandonProcessGroup` and the systemd unit `KillMode=process`. An
  existing autostart keeps its old file until you run `caprock service
  install`; `caprock service status` says when the file differs. On Linux this
  step is needed for sessions to survive a service restart.
- **A session whose terminal closed says so plainly.** For a session started by
  an earlier release, the Terminal tab now reads "This session's terminal was
  closed when Caprock restarted. The conversation is saved — Continue it here
  resumes it in a new terminal." **Continue it here** carries the same
  conversation on (stopping the old terminal-less process first, which Caprock
  started); **open a copy instead** leaves that process running.

### Fixed

- **A carrier-NAT address is no longer offered as Tailscale.** Network access
  admitted any address in 100.64.0.0/10 as a Tailscale one. That block is
  carrier-grade NAT, which Tailscale borrows: a laptop tethered to a phone or
  behind an ISP's CGNAT can hold such an address on its Wi-Fi, and binding it
  invites everyone behind the same carrier. The range now counts only on
  Tailscale's own interface — named `tailscale*`, or carrying Tailscale's IPv6
  prefix `fd7a:115c:a1e0::/48`, which is how it looks on macOS.
- **Open a session in your own terminal.** The session's title row (next to
  Open repo, on every tab) and the Projects terminal menu carry **Open in
  Ghostty ↗** (named for your terminal), which runs the agent's own resume command —
  `claude --resume`, `codex resume`, `opencode --session` — in the session's
  folder, in Ghostty, iTerm2, Terminal, WezTerm, kitty or Warp on macOS, your
  `$TERMINAL` or a common terminal on Linux, and Windows Terminal, PowerShell
  or cmd on Windows. Caprock keeps measuring it through hooks and the
  transcript, as it does any session you start yourself. A session Caprock is
  running can be **moved** (stopped here, carried on there) or **forked**; one
  running somewhere else can only be forked, because Caprock never stops a
  process it did not start. Pick another terminal from the ▾ menu and it
  becomes the default.

## [0.70.0] - 2026-10-04

### Added

- **Open the repository from a session or a project.** The session header
  links the repository — the branch's page where the host has one — and the
  pull requests the session opened, newest first, with "merged" only where a
  merge was recorded. A project row links its repository and its last pull
  request. The address is read from the local git remote (GitHub, GitLab,
  Bitbucket, Codeberg and other hosts; ssh or https); nothing is asked of the
  host.
- **Screens show their last figures while the new ones load.** Now, Lifetime,
  History and a session's header open with what this browser last saw,
  marked "updated N min ago · refreshing", instead of dashes. Nothing about
  the present — health, burn, controls — is drawn from the kept copy.
- **Start Codex and OpenCode sessions from Caprock.** The New session dialog
  has an agent picker — Claude Code, Codex, OpenCode, Gemini CLI — showing only
  the ones installed on this machine, and it remembers the one you picked last.
  Each runs as its own TUI in the terminal tab, with its own model choice
  (Codex's own model list; OpenCode's `provider/model`) and the permission
  choice translated into that agent's flags. Cost, turns and answers land on the
  same session page as the terminal, and an ended Codex or OpenCode session can
  be continued with "continue here".
- **Week: a card of what your agents shipped, to post.** A new Week tab
  draws seven days of this machine's work — pull requests opened and merged,
  commits, files and ≈lines written, what it cost at list price, ≈cost per
  merged PR, the share spent re-reading context, who did what (Claude Code,
  its subagents, Codex, OpenCode, Gemini CLI, DeepSeek), the longest loop and
  the biggest session — as a 1200×675 or 1080×1350 card in your theme.
  Download it as a PNG or copy it to paste. Everything is counted on your
  machine from the agents' own tool calls; Caprock does not ask GitHub, and
  no repository, path, prompt or session title is ever on the card.
- **Now: At a glance.** A collapsible block after All time draws where the
  money went, the bill by token type (with the share spent re-reading
  context in the middle) and the most-used tools as donuts, plus one tile per
  agent with its share of all-time cost. A Charts | Numbers switch shows the
  same figures as tables; both choices are remembered.
- **Live pulse says who is working and on what.** Each session row shows the
  current model by name and, when subagents are running, a crowd icon with
  "×N".
- **Share: a Story card, for any period.** The share dialog gains a second
  style beside Figures: the Week card — the headline, the money beside it,
  who did what, the longest loop and the biggest session — for today, this
  week, this month or all time, at 1200×675 or 1080×1350.
- **Click a tool for what it did.** On Lifetime, a tool's row opens in
  place: Bash by the command each call ran ("go test", "git diff"), Read and
  Edit by file, WebFetch by domain, WebSearch by query, an MCP tool by its
  action, with calls and share. Premium adds what came back, how often each
  group failed, a trend per group and hints drawn only from those counts.

### Changed

- **A project's terminal is a button you can see.** Each Projects row has a
  full-size button that says what it does: **Terminal** opens the session
  Caprock is running there, **Pick up in a terminal** branches one started
  elsewhere, **New session here** starts one. The full menu stays behind ⋯.
  It replaces a small `>_` at the row's edge.
- **The Teams and Premium dialogs show what you get before they describe
  it.** Each now opens with a small picture in the Week card's style — an
  example team's week for Teams; the daily cap stopping at its line, a
  question to Gemini about your own sessions, or the Monday report for
  Premium — clearly tagged as an example, followed by a few short lines and
  the two ways forward. Premium's prices are the site's: $30 a year, or $100
  once marked Best value, in the product's amber rather than blue. Focus now
  moves into the dialog and back to what opened it.
- **Plan limits are gauges, directly under Today.** Each window is a ring
  that turns amber at 60% and red above 85%, with its reset time and a
  countdown, grouped by agent. A forecast still appears only when your pace
  would hit the limit before the reset, and is drawn on the ring; Codex is
  never forecast and says how old its reading is. A stale reading is drawn
  grey and says so.
- **Plan limits explain themselves.** Each window says, in words, how much
  is used, when it resets and how long that is (in minutes under an hour),
  and that Claude Code pauses at 100% until then. One line says these are
  Anthropic's limits per 5-hour window and per week, not Caprock's, and near
  the limit a note says to wait for the reset or switch to Codex if it has
  room. The same panel is on Now and Cost, and the limit alert now opens it
  directly.
- **Lifetime reads like the site.** The money leads, large, with what it
  came to per active day and per session beside it, then the cache and the
  counts. Top projects come first, as a donut beside the table; tool usage
  and the model mix are donuts with the rest grouped as "other", or tables,
  by a Charts | Numbers switch.
- **The share dialog shows a card at once.** It draws the last figures for
  the period while the current ones load, and with nothing kept it shows the
  card's outline with each range ticking off as it answers, instead of an
  empty box. Saving or sending always uses the current figures.

- **Continue a session in another agent.** "Continue in…" on a session page
  starts a new Claude Code, Codex, OpenCode or Gemini CLI session in the same
  folder, with a summary as its first message: the last thing the agent said,
  what has changed in the working tree, and the pull requests it opened. You
  read and edit the summary before anything is sent, and both sessions link to
  each other. It is a new session with a summary, not the same conversation —
  which also makes it the way to pick up a session whose transcript is gone.

### Fixed

- **Opening a session's terminal no longer freezes the page.** The terminal
  set up its GPU renderer before it connected, and connected only after the
  session's figures had loaded; the figures were then reloaded on every event.
  It now connects and takes the keyboard first, switches to the GPU renderer
  once you pause, and reloads the figures every 30 seconds while you type.
  Keys typed the moment it opens reach the session.
- **A terminal that is starting says so.** A resumed session can take half a
  minute to print anything; the panel showed black until then. It now counts
  the seconds, and after 30 seconds with nothing, or if the session closes
  first, says so and offers Retry.
- **A session's Answers tab shows what Claude wrote again.** Claude Code now
  writes a thinking line ahead of every reply, and Caprock kept only the first
  line of each reply — so the prose after it was never stored, and a session of
  long answers showed one line. The rest of a reply is now kept with it, and
  replies stored since the change are filled from the transcripts on disk once,
  in the background, after an upgrade. Memory search and the handoff a new
  session receives read the same prose and are mended with it.
- **A long link in an answer no longer widens the page.** One unbroken URL in
  a reply made the Answers tab scroll sideways and pushed the session's
  buttons off the screen; it now wraps.
- **The Answers tab opens at once.** It read every reply on the machine to find
  one session's; on a 1 GB database that was 3.3 seconds cold for a session of
  21 replies, and is 20 ms now.
- **The terminal is dark in the light theme.** Claude Code's dim text and
  status line were grey on paper and could not be read. The terminal now keeps
  its dark palette in both themes, and keeps it when you switch theme with a
  terminal open — it used to stay in the colours of whichever theme was on
  when it opened.
- **Now waits less for its figures.** The status the screen polls counted every
  event and searched a fortnight of prose on each call; both are reused for a
  minute now.
- **Assistant turns are no longer lost when the database is busy.** Since
  0.68.0 the recorder checks whether a forked session's turn was already paid
  for before storing it, and that read-then-write transaction failed at once
  with "database is locked" whenever another write was in progress — about
  400 times an hour on a busy machine. The transcript reader logged the error
  and moved past the line, so the turn never arrived. Transactions now take
  the write lock up front and wait for it, a line that still meets a busy
  database is read again instead of skipped, and on first start the
  transcripts written since 3 October are read once more to recover what was
  dropped (on the owner's machine: 259 turns, $18.52).
- **Every page loads fast on a large database.** On a 1 GB database with
  sessions running, the main screen's requests took up to 3.6 seconds each.
  All-time history and the 7-day, 30-day and all-time summaries are now
  computed in the background and served from memory, refreshed as they are
  asked for; the whole database file is memory-mapped, so a read after a
  write no longer starts cold; and the sessions list finds each session's
  first prompt through its own index. The same requests now answer in under
  0.1 seconds, and the share dialog's preview no longer waits on four
  whole-history scans. Today's figures are still computed on every request.
- **A session with no activity yet no longer reads "idle 739892d ago".**

## [0.69.0] - 2026-10-04

### Added

- **Gemini 3.8 Flash and Gemini 3.1 Flash-Lite are priced.** A Gemini CLI
  session on either model had its tokens counted but no cost, and the Cost
  screen named the model as unpriced. Both now carry Google's list prices,
  read 3 October 2026 (pricing table `2026-10-03.1`). Gemini 3.8 Flash is on
  introductory pricing that doubles on 1 January 2027; the table will be
  refreshed before then.

### Fixed

- **Documents dropped into a session's terminal arrive.** Dragging a Markdown,
  CSV, JSON, YAML, log or source file from Finder printed "415 Unsupported
  Media Type", because the browser gives those files no type and only images,
  PDF and plain text were accepted by type. Files are now accepted by
  extension — images, PDF, text and documents, Office files, data and source
  files — every dropped file is attached, not only the first, and each keeps
  its own name, so Claude reads `contract.pdf` rather than a timestamp. A file
  that is refused says which types are accepted.
- **The README no longer lists starting a Gemini CLI session as Premium.** It
  never was: the New Session dialog offers Gemini CLI to everyone, like every
  other agent. Asking Gemini about your numbers is the paid part.

## [0.68.0] - 2026-10-03

### Changed

- **The light theme is paper now, like caprock.dev.** A cream ground with
  panels a shade lighter, instead of white. Prefer white? Settings → Light
  theme → White; the choice is kept in this browser. The dark theme is
  unchanged.

### Fixed

- **Test readings no longer sit in your plan-limit history.** A unit test
  posted a made-up 23.5% five-hour reading, with a reset in 2030, to whatever
  Caprock daemon was running when the tests ran. Any such reading is now
  removed, by the same rule the daemon already applies to new ones: a reset
  more than eight days ahead is not a real window.
- **A forked session no longer counts its parent's spend a second time.**
  Picking up a running session forks it, and Claude Code copies the
  conversation since its last compaction into the fork's transcript, usage
  included. Caprock priced every copied turn again, so the copied spend showed
  up twice in Cost, the daily totals and `caprock report`. On the machine this
  was found on, one fork added $212.93. A copied turn now stays in the fork's
  timeline with its text but costs nothing, and the copies already stored are
  corrected once when the daemon starts.
- **A copied turn with no usage is no longer charged for a cache write.**
  Claude Code blanks the token counts of some messages it carries past a
  compaction but leaves the 1-hour cache-write figure, which was priced on its
  own.

## [0.67.1] - 2026-10-03

### Fixed

- **Codex sessions older than a week are read again.** Codex compresses a
  session it has not touched for seven days into a `.jsonl.zst` file and
  removes the original. Caprock read only the uncompressed files, so a new
  install or a rebuilt history saw one week of Codex and nothing before it.
  Compressed sessions are now read like the rest.
- **The Team seat preset is $25, not $30.** Picking "Team seat" as your plan
  priced it at $30 a month; Anthropic lists a standard seat at $25 billed
  monthly ($20 annually), so Plan value understated what the usage was worth
  against it.

## [0.67.0] - 2026-10-03

### Added

- **What Caprock for Teams is, without leaving the dashboard.** The Cost
  screen has a one-line banner that starts from this machine's spend and
  project count. It, the Projects team line and the footer link open a dialog
  that says what the team version is, what a lead gets, and why it is worth
  paying for, with links to book a demo, the team page and pricing. The Cost
  screen shows this instead of the Premium banner, which stays on Now and
  Lifetime. "Not now" hides it for a month.

## [0.66.0] - 2026-10-03

### Added

- **1-click terminal.** Each project on the Projects panel has a `>_` button.
  When one session Caprock started is running in that project, a click opens
  its terminal. Otherwise you choose: open one of Caprock's sessions, continue
  an ended one, branch one still running in another terminal, or start a new
  session in the project's folder. A running session card on Now opens straight
  in its terminal too. Caprock still never types into a session it did not
  start; continuing or branching starts a second process.

## [0.65.0] - 2026-10-02

### Added

- **What you ask Gemini CLI is kept, like every other agent's prompt.** Gemini
  sessions started from Caprock now record the question, so Memory can find a
  session by what you asked it. Sessions from before keep none.
- **OpenCode replies can be found by the question you asked.** What you type
  in OpenCode is now stored like a Claude Code prompt, so Memory search finds
  a reply by your own words, and an untitled session is described by its first
  question. Sessions read before are filled in on the first start. Text
  OpenCode or another app adds to a message on its own is left out.

### Fixed

- **A DeepSeek Harness session's timeline shows what you asked.** The prompt
  rows were blank, because DeepSeek keeps the prompt under a different name.
- **A session shows the model it runs on, not its subagent's.** When a
  session's subagent ran on a different model — an Opus session sending an
  Explore task to Haiku — the session took the subagent's model on its card,
  in the session lists and in the context window it was measured against.
  The subagent's turns still count toward the session's and the day's cost,
  by their own model. Sessions already stored with the wrong model are
  corrected once, on the next start.
- **Context fill no longer drops while a subagent works.** The badge measured
  the session's last turn, and a subagent's last turn starts from a small
  prompt of its own, so a nearly full context read nearly empty until the
  subagent finished. It now measures the session's own last turn.
- **Memory search finds the reply to a question asked earlier in time.** A
  reply was matched to whichever prompt Caprock happened to store just before
  it, so a question stored later than its answer — all of OpenCode's history,
  a few Claude Code exchanges — never found it, and some replies were tied to
  an older question than the one they answered.
- **DeepSeek sessions no longer list injected instructions as your prompts.**
  The AGENTS.md, CLAUDE.md and runtime-context blocks stored before this was
  fixed are removed once, checked against DeepSeek's own transcripts.

## [0.64.0] - 2026-10-01

### Security

- **The weekly report's bot token no longer reaches the log or the screen.**
  When Telegram could not be reached, the error quoted the request URL, and
  the URL contains the token; that text went to the daemon log and to the
  report's last-error line in Settings. The error now names the cause only.

### Added

- **Memory shows what OpenCode wrote.** OpenCode's replies are now stored like
  Claude Code's, so they appear in Memory and its search, history included —
  the first start fills in sessions imported before. A subagent's replies stay
  out, as Claude Code's do.

- **What Codex wrote back is in Memory.** Codex replies now appear on the
  Memory screen, in its search and in a session's Answers tab, the same way
  Claude Code's do. Replies from sessions Caprock had already read are filled
  in once, in the background, from the transcripts Codex keeps. Sessions Codex
  imported from Claude Code are left out, because those answers are already
  there from Claude Code itself, and so is the chatter of Codex's own
  subagents.

- **See how much disk Caprock uses, and on what.** The Status screen has a
  Storage panel: the total on disk, what it is made of (events, their indexes,
  logs and the rest), which agent and which kind of event recorded the most,
  roughly how much it grows a day, and what you can do about it — how much a
  retention setting would delete, and whether compacting the database would
  give anything back.

### Fixed

- **The Tasks screen says who runs a task.** It read "one Claude session per
  task"; an orchestrator hands each task to a worker, and the screen now says
  so. The README's pairing steps now say a code appears after *Show a code*.
- **Screenshots no longer print a folder name the scrubber missed.** Two
  folders with the same name were numbered `<name>-2`, and the numbered one
  kept its real name; the scrubber now rewrites it and refuses to finish if any
  real project name is left.

- **Sessions Codex imported from Claude Code no longer count as Codex spend.**
  Codex Desktop can import a Claude Code session, and Caprock read the copy
  as Codex work: the same tokens counted twice, the second time at OpenAI's
  prices. Those threads are now skipped, and the first start takes what was
  already stored back out of every total. On one machine that was $26.70.

- **Work done by Codex subagents is no longer lost.** A subagent's turns
  could be mistaken for its parent session's own and dropped, along with their
  cost; on one machine nearly half of them were missing. They are now kept,
  shown as part of the session that started them, and the first start brings
  back the ones dropped before.

- **Opus 5.5 and Sonnet 5 are priced right, including the turns already
  stored.** Opus 5.5 had no row and was priced as Opus 5 — $5/$25 instead of
  $4/$20, and cache reads at $0.50 instead of $0.20. Sonnet 5's rise to $3/$15
  on 31 August was cancelled, but Caprock priced every Sonnet 5 turn from that
  day at it. Pricing table `2026-10-01.1` adds Opus 5.5 and Sonnet 5.5, keeps
  Sonnet 5 at $2/$10, and lists both as corrections: on the first start the
  daemon reprices those turns once and moves the session and daily totals by
  the difference. A price that really changed still never restates history.

- **A DeepSeek Harness reply can be found by the question you asked.** Memory
  search looked for the prompt where Claude Code keeps it, and DeepSeek keeps
  it elsewhere, so no DeepSeek question matched. The instructions DeepSeek
  injects into a session are no longer taken for something you typed.

- **A session whose folder is gone offers a command that works.** The copy
  command began with `cd` into the missing folder, so it failed before
  `claude` started. `claude --resume <id>` finds the session from any folder,
  so that is what is offered now, while the transcript is still there.

## [0.63.0] - 2026-10-01

### Security

- **A paired tablet or phone can read Caprock and no longer control it.** The
  device token was the only check, so a paired device could start a command,
  type into a session, pause or kill it, change settings and the licence,
  create and approve tasks, start the orchestrator and turn the task runner on
  — everything the dashboard on the machine can do, although ADR-029 says a
  tablet is somewhere to read figures, not a second control room. A paired
  device may now make only a named list of reads; anything else is refused with
  403, including the terminal socket and the folder listings, and a route
  added later is closed to it until it is named. It no longer receives the
  licence key with the settings. The tablet's dashboard stops drawing the
  controls it cannot use. Nothing changes on the machine itself.

### Added

- **Codex's plan limits on the Cost screen.** The 5-hour and weekly windows
  Codex writes into its session transcripts now sit in the Plan limits panel
  under a Codex heading, beside Claude Code's, with the time Codex wrote them.
  Only the windows your plan has appear — some ChatGPT plans have no 5-hour
  window — and they are shown as measured, never forecast.
  `/v1/stats/summary` carries them as `codex_rate_limits`.

### Fixed

- **Codex sessions outside `~/.codex/sessions` are imported.** Caprock now
  reads `$CODEX_HOME` when it is set, and `archived_sessions/` as well as
  `sessions/`, so archived threads and a relocated Codex home are no longer
  missing from the totals. A thread archived after it was imported is not
  counted twice.
- **The Cost screen no longer says "At Anthropic list prices"** above a model
  table holding GPT rows; it says "At API list prices". `caprock report` names
  every vendor whose prices make up its total ("Anthropic and OpenAI list
  prices") and stops calling a mixed total "Claude Code".
- **`caprock statusline install` no longer sends you in a circle.** With a
  status line of your own already set, it said "run `caprock statusline
  install`" — the command you had just run. It now names the settings file and
  the exact `statusLine.command` value to set, and still changes nothing.

## [0.62.0] - 2026-10-01

### Added

- `caprock export` writes Caprock's record out as TSV, CSV or JSON lines:
  `events` (one row per turn, tool call or lifecycle event) or `sessions`, with
  the same columns whichever of the five agents wrote the source. Filters by
  `--since` and `--agent`; `--payload` adds the raw source record to JSON lines.
  It reads the database read-only and works with the daemon stopped. The column
  sets are documented in `docs/schema.md` and only ever grow at the end (FB-041).

## [0.61.0] - 2026-09-30

### Added

- The memory handoff can be measured. Ticking **Measure whether it helps**
  holds it back from one new session in four, at random, and the Memory screen
  compares the two groups: minutes and tool calls to a session's first edit.
  Off by default. On the owner's machine a session continuing yesterday's work
  reached its first edit no faster than one starting cold, with the handoff
  already on — this is how to find out whether it does anything.

## [0.60.1] - 2026-09-30

### Fixed

- Codex sessions on `gpt-6-astra` and `gpt-6.1-sol` are priced (OpenAI list
  prices, read 2026-09-30). They showed as "Partial cost"; the turns already
  stored are priced on the next start. The gpt-6 rows also carry OpenAI's
  cache-write rate, which Codex does not report tokens for yet.

## [0.60.0] - 2026-09-30

### Added

- After a reboot or an OS update, the Now screen names the sessions that were
  still running when Caprock stopped, each with **continue**, until dismissed
  (FB-038). They used to be a few ended cards among a hundred, found by opening
  each.
- A `/clear` or a fork is one card, not several: the earlier parts of the
  conversation ride on the latest card as links (FB-039). Only recorded facts
  join sessions — the same process after `/clear`, or a fork Caprock started —
  never the same folder or branch.

### Fixed

- An ended card shows when the session was worked in — "worked 29 Sep
  14:02–16:40" — not when it was closed. After a reboot every card read the
  reboot's time (FB-037), and the list is now ordered by the same time.
- A session from before a reboot is ended even when its old process number now
  belongs to another program. It stayed "live" instead, and its terminal tab
  was an empty screen.
- The terminal tab of a session Caprock started before it restarted says the
  terminal went with that run and offers continue, instead of an empty screen
  (FB-040).

## [0.59.6] - 2026-09-30

### Fixed

- Hook events are no longer lost when the database is busy. The shim waits a
  second and hangs up, and an event still waiting for the write lock was
  abandoned with it — 41 on the owner's machine, each logged as "context
  canceled" and missing from the record. The write now finishes after the
  shim has gone.
- The log no longer grows without bound. A model missing from the pricing
  table was warned about on every event, re-reads included — 1.1M identical
  lines and a 4.6GB `caprock.log`. It is now said once per model, and the
  daemon's log is rotated at 64MB with one previous file kept; a log the
  daemon has stopped writing to is cut to its last 8MB.
- Restarting the daemon no longer re-reads every Codex transcript. On the
  owner's machine that was 1.1GB and 30k duplicate writes on every start,
  while the dashboard and hooks waited; only transcripts that changed are
  read now.

### Changed

- CI checks the query plan of every aggregate the dashboard polls and fails
  when one would read full event rows instead of a covering index — the
  regression behind 0.59.2 and 0.59.3, which a small test database could
  never show by timing.

## [0.59.5] - 2026-09-30

### Fixed

- A session started from Caprock right after the daemon starts gets your
  login shell's environment instead of the daemon's bare one. Reading it was
  cut off after 5 seconds, and at start — while every importer does its first
  pass — it could take longer; the failure left nothing to fall back on but
  launchd's `PATH`, so `gcloud` went missing again (FB-033). The limit is now
  30 seconds, a failed first read retries on its own, and a session started
  meanwhile waits up to 15 seconds for it.

### Added

- `caprock status` says which environment sessions start with — your login
  shell's, still being read, or the daemon's with the reason — so a session
  that cannot find a tool a terminal can find is one line to diagnose.

## [0.59.4] - 2026-09-30

### Changed

- Built with the modernc.org/sqlite 1.59 driver, and the dashboard with
  Vite 8.3.1. No change in behaviour; the summary and history timings were
  re-measured against the same database copy as 0.59.3 and match.

## [0.59.3] - 2026-09-30

### Fixed

- The Lifetime screen and the all-time figures on Now load in about a second
  instead of nine. The indexes the spend aggregates read from stopped covering
  them when background usage was split out; migration 0026 rebuilds them
  (about ten seconds on a large database, once, on the first start). The
  History totals for today read off the time index like the summary's already
  do (4.8s to 0.02s on the owner's database).
- Rebuilding the Codex daily totals no longer fails on a busy first start
  with "database is locked"; it used to wait for the next restart.

## [0.59.2] - 2026-09-30

### Fixed

- Today's totals load in a fraction of a second again. Two of the queries
  behind them walked every event in the database instead of today's, once
  the background-usage split added a column their indexes did not cover; on
  a 300k-event database the summary took 3.7s at rest and tens of seconds
  while a session was busy, and screens sat on "reading your figures…" or
  "loading…". Measured on a copy of the owner's database: today 3.7s → 0.5s,
  7d 1.9s → 0.15s.

## [0.59.1] - 2026-09-30

### Fixed

- The dashboard no longer piles up requests while a session is busy. Every
  live event made each panel ask again, whether or not its last request had
  answered, so on a large database today's totals fell 30-60 seconds behind
  and read "reading your figures…" while the daemon ran at over 100% CPU. A
  panel now waits for its running request and asks once more after it.
- `make shots` waits until every placeholder on a screen has cleared, and
  fails rather than capturing a half-loaded one.

## [0.59.0] - 2026-09-30

### Added

- Every session card says what the session was about: Claude Code's, Codex's
  or OpenCode's own title for it (the name their resume pickers show), or else
  its first prompt that says something. Ended sessions can finally be told
  apart (FB-035).
  OpenCode sessions imported before this release get their titles too.
- Pricing for GPT-6 Sol and GPT-6 Luna, from OpenAI's published list prices
  (read 2026-09-29). Turns already stored without a price because their model
  was missing from the table are priced on the next start, at the rate in
  force when they ran; turns that were priced keep their figures.
- An ended session says whether it can be continued and, when it cannot, why:
  the transcript was deleted by Claude Code, the folder is gone, or the agent
  is not one Caprock resumes — with the command to resume it yourself where
  the agent has one (FB-036).
- Ended session cards say when the session ended and offer **continue** (or
  why not) right on the card. With ended sessions shown, a search box finds a
  session by its title, any prompt typed in it, its project or branch, and
  **show more** reaches past the first 200.

### Fixed

- A session started from Caprock can now reach what a terminal can: `gcloud`,
  `bq`, Homebrew tools and everything the shell profile exports. Sessions and
  verification commands used to inherit the daemon's environment, which under
  launchd autostart is a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; they now
  start with the user's login-shell environment, resolved in the background at
  start and refreshed in the background once it is more than a minute old
  (FB-033). Caprock runs your `$SHELL -l -i` to read that environment; the
  shell sees `CAPROCK_RESOLVING_ENVIRONMENT=1`, so a profile can skip
  interactive-only work. Windows is unchanged.
- A session started from Caprock no longer inherits Claude Code's session
  markers when the daemon itself was started from inside a Claude Code session.
- Pasting into the terminal sends the text once. Cmd+V (Ctrl+Shift+V off macOS)
  used to paste twice whenever the browser allowed a clipboard read, so short
  text appeared doubled (FB-034).
- A long paste collapses into Claude Code's "[Pasted text]" block again after
  switching tabs or reloading. A terminal that attached after the session's
  first 256 KB of output never learned that bracketed paste was on; the daemon
  now restores the terminal modes the session set before replaying scrollback.
- Sessions Caprock started can be continued after they end; the button used to
  disappear for them, including after they had been continued once.
- Continuing a session whose transcript is gone is refused with the reason,
  instead of opening a terminal that printed "No conversation found" and
  exited.
- Daily totals no longer count some Codex turns twice. Migrations 0022 and
  0023 re-imported every Codex event without taking the first import out of
  the daily table; the Codex rows are rebuilt from events once on start
  (on the owner's machine, five days $3.68 and 7.9M tokens too high). A Codex
  turn repriced after its model became readable now moves the session and
  daily totals with it.
- Pasting an image with the keyboard uploads it and types its path; only
  drag-and-drop worked before, because xterm stopped the paste event from
  reaching our handler.

## [0.58.3] - 2026-09-13

### Changed

- Refreshed the shipped UI's React runtime, React types, and Node types; the
  embedded production bundle is rebuilt and verified across all CI platforms.

## [0.58.2] - 2026-09-13

### Changed

- Refreshed the SQLite and Go system dependencies and the pinned GitHub Actions
  used by CI, with the full cross-platform verification matrix still green.
- Dependabot updates are grouped by ecosystem and capped at three open PRs;
  npm major updates remain separate for deliberate review.
- The README pulse animation now advances every 60 ms instead of 250 ms, so a
  complete dark or light cycle takes about 5.5 seconds and reads as live motion.

## [0.58.1] - 2026-09-12

### Added

- Checked-in DeepSeek Harness transcript fixtures cover current and legacy JSONL
  formats without depending on a developer's `~/.dsh` directory.
- Dependabot now watches GitHub Actions, Go modules, and `ui/` npm dependencies.

### Changed

- GitHub Actions are pinned to immutable commit SHAs with readable release
  comments, reducing supply-chain exposure while keeping updates automated.
- The incomplete-cost warning now says `Partial cost`, offers copy/report/why
  actions, and explains the lower-bound total only on demand. No manual price
  entry is required.

## [0.58.0] - 2026-09-12

### Added

- **DeepSeek Harness is the fifth agent on the same screen.** Caprock now reads
  DSH's own session transcripts (`~/.dsh/sessions/…`, zstd JSONL) and shows its
  sessions, turns, tool calls and cost beside Claude Code, OpenCode, Gemini and
  Codex. The model DSH names — `deepseek-v4-pro` — was already in the pricing
  table, so no pricing change was needed. Observation-only, like Codex: Caprock
  reads the files and does not start, steer or stop DSH sessions.

## [0.57.0] - 2026-09-11

### Changed

- **The default port moved from 4173 to 22776.** 4173 is Vite Preview's
  default, so a developer running `vite preview` beside Caprock hit a bind
  collision. A fresh install now listens on 22776 (unassigned by IANA, spells
  CAPRO on a phone keypad); an existing install that never wrote `config.json`
  keeps its old 4173 origin, because a port is part of a browser origin and
  moving it would strand bookmarks and LAN-pairing tokens.

### Fixed

- **Codex's own approval reviewer was reported as user work.** `codex-auto-review`
  is Codex's hidden "Automatic approval review model", and it writes a normal
  transcript that raised an unresolvable unpriced-cost warning (OpenAI publishes
  no price for the id). It is now classified as background machinery, kept out
  of every user-work total, and reported beside them as a quiet "background
  usage" line with no dollar value. A genuinely unknown model still gets the
  actionable "partial estimate" with a prefilled report issue.

## [0.56.0] - 2026-09-09

### Added

- **The context tax, in the screens you already look at.** Every call re-sends
  the whole conversation as a cache read before it does anything, and Caprock
  stored every number needed to price that and showed none of them. It now
  does, in three places and no new ones: the session card's Context caption
  says what the next call costs at the current fill (`$0.07/call`), the
  lifetime Breakdown carries a `Context tax` row with its dollars and its share
  of what was priced, and a loop alert states what the repeated calls paid to
  re-read the conversation. On the author's own archive that row reads $11,117
  of $13,910 — 80%.

  Two limits are stated rather than papered over. Cache-read rates come from
  the pricing table per model, because Fable 5.1 and Mythos 5.1 read at 0.025x
  where the rest of the table reads at 0.1x. And a tool call is priced through
  the turn that paid for it, which the hook plane cannot identify: where some
  of a loop's calls are unlinked the alert says "at least", and the Breakdown
  row names the volume it had to exclude.

### Fixed

- **The recording stand outlived its terminal, forever.** Eight of them were
  found still running, the oldest two weeks old, each holding a daemon and a
  temp directory open. `sleep 3600` in a hold loop is a separate process, and
  bash will not run a trap until it returns — so a stand started detached never
  received the interrupt that would have stopped it. It waits on an
  interruptible sleep now. Affects `make record` only, not the daemon.

## [0.55.0] - 2026-09-06

### Changed

- **More words for a cache hit rate, and a shorter cost on the status line.**
  98% and 99% were both "outstanding"; there are now `excellent` (98–99) and
  `very good` (96–98) between it and `good`, which moves down to 90. And the
  status line's cost read `$169.410` — a trailing zero on a line that reprints
  after every message. It now shows two decimals, matching the dashboard, and
  four only below a cent: one decimal was the obvious cut, but 92 of 250 real
  sessions round to zero at one place, and a session that cost money should
  never report nothing.

- **The waiting banner said the same thing twice.** It read `Waiting on you ·
  caprock · waiting for you` — one sentence in two prepositions, the repeat in
  grey as though it were extra information. Now it says it once, as "Waiting
  for you", and the "what did it ask?" button beside it is the part that
  actually tells you something.

## [0.54.5] - 2026-09-06

### Fixed

- **Codex figures already on your screen are corrected.** 0.54.4 fixed how
  token reports are read and could not reach the turns already stored — those
  kept showing no tokens and no cost. They are re-read from the transcripts on
  the next start, which takes seconds and needs nothing from you.

## [0.54.4] - 2026-09-06

### Fixed

- **Half of Codex's token reports were being thrown away.** About half the
  turns in a Codex transcript state how many tokens they used without breaking
  it down by kind, and Caprock read only the breakdown — so those turns were
  stored as having used nothing at all. On the owner's machine that hid 18.6M
  tokens and turned $23.71 of usage into $0.53.

  Such a total is now counted as input, which is the unqualified rate: nothing
  is credited a cache discount it was not reported to have earned, and no split
  is invented across kinds. For those turns the cost is therefore an **upper
  bound** — any part of the total that was really a cached read cost a tenth of
  what is shown. A turn that genuinely used nothing is still stored as nothing.

## [0.54.3] - 2026-09-06

### Fixed

- **A Codex transcript with one unexpected field was skipped entirely.** The
  session record was read all-or-nothing, so a single field of a type we did
  not expect discarded the session id — and with it every turn in that
  transcript. Each field is now read on its own: an unfamiliar shape costs that
  field, never the session. Codex is someone else's format and free to change
  between releases, so this is the difference between missing a detail and
  missing a day's work.

## [0.54.2] - 2026-09-06

### Fixed

- **Codex sessions were missing more than half their turns.** The importer
  keyed each event on a field present in one transcript out of a hundred; in
  the rest it read as zero, so every turn of a session shared one key and all
  but the first were discarded as duplicates. One session kept 1 turn of its
  55. On the owner's machine 98 turns were stored where the transcripts hold
  218, with 18.5M tokens missing along with them.

  Keys now come from the record's position in the file, which is unique by
  construction. A migration clears the Codex events already stored — they are
  re-read from the transcripts within seconds of the next start, so nothing is
  lost — and the figures come back complete: 218 turns and $3.30 where it had
  been 98 and $0.38.

## [0.54.1] - 2026-09-06

### Fixed

- **Codex sessions now all carry a price.** v0.54.0 shipped with 83% of Codex
  tokens costing nothing, because it read the model from the obvious field —
  present in 4 transcripts out of 100. The other 96 record it elsewhere, as an
  explicit model id rather than a hint, so both are read now and every session
  that used tokens can be priced. A session that names no model anywhere still
  keeps its tokens and no cost, rather than an invented one.

- **A test daemon read the machine's real Codex transcripts.** The smoke test
  asserts exact turn and cost figures, and on a developer machine with Codex
  installed it was importing that person's actual sessions and counting them.
  It turns the import off, as it already did for OpenCode.

## [0.54.0] - 2026-09-06

### Added

- **Codex sessions are on the dashboard.** A machine running Claude Code,
  OpenCode and OpenAI Codex had its spend split three ways, each tool knowing
  only its own share. Codex sessions, turns, tool calls and cost now sit on the
  same screens as the others, filterable by agent. Nothing to install: Codex
  writes one transcript per session and Caprock reads it, the way it already
  reads OpenCode's database.

  **Every Codex session that used tokens is priced**, which took finding where
  Codex actually records the model. The obvious field is in 4 transcripts out
  of 100; the other 96 record it somewhere else entirely, and reading only the
  first left 83% of tokens with no cost at all. Both are model ids Codex wrote
  down, not guesses from the version or the app that launched it. A session
  that names no model anywhere still keeps its tokens and carries no cost
  rather than an invented one.

  Pricing gained OpenAI rows (`gpt-5-codex`, `gpt-5.3-codex`, and the `gpt-5.6`
  family), read from OpenAI's published prices on 2026-09-06.

### Fixed

- **The share dialog's preview never changed when you switched period** — and
  on a real machine it never appeared at all. Two faults in the same box. The
  draw released its image on teardown, so changing period released the one
  still on screen, and a released image leaves the previous picture showing.
  Under that, anything the drawing threw on killed the draw silently and left
  "drawing…" on screen for good, which looked exactly like a slow one. The card
  you saved was always right; the preview was a lie about it. A draw that
  cannot finish now says so.

### Removed

- **The "Lots of turns, few files" alert.** It counted files touched through
  Edit/Write only, so everything changed through Bash — `sed -i`, a heredoc, a
  python one-liner — was invisible to it. An agent running with permissions
  bypassed is told to prefer exactly those, so the rule was blind to an
  ordinary way of working.

  On the owner's machine it had fired three times ever, on sessions that made
  636, 418 and 288 Bash calls. All three were wrong, and one of them had
  shipped three releases while the banner said "no files touched". A rule with
  no true positives is not a threshold to tune, so it is gone rather than
  retuned. Counting files out of shell command text would be guesswork; if this
  ever returns it should be built on what git actually says changed.

## [0.53.2] - 2026-09-06

### Fixed

- **A status line that had silently printed nothing is repaired on start.** An
  older version wrote the registered command with quotes around the whole
  string rather than just the path (`"…/caprock statusline"`). The shell reads
  that as one filename, finds no such file, and prints nothing — so the status
  line was simply blank, with nothing anywhere saying why. Worse, Caprock did
  not recognise the entry as its own, so `statusline install` treated it as
  somebody else's and refused to touch it: the machine it was found on had been
  in that state for months. `caprock up` now recognises the spelling, repairs
  it, and says so. A statusLine that is not ours is still never touched, and
  neither is a working one.

## [0.53.1] - 2026-09-06

### Fixed

- **Every coloured border in the dashboard was grey.** A global border reset
  sat outside Tailwind's cascade layers, and unlayered CSS beats layered CSS
  whatever its specificity — so it quietly overrode every `border-accent`,
  `border-premium`, `border-ok` and `border-warn` in the app. It went unnoticed
  because the elements using them mostly have a tinted background too: the
  "+ New session" button looked amber because of its fill, not its border.
  Buttons and status pills now show the colour they always asked for.

### Changed

- **The two session buttons line up with the strip beside them.** Quick chat
  and + New session were shorter than the ALL TIME row they share, which read
  as ragged; they now match its height. Quick chat gains a soft amber border.

## [0.53.0] - 2026-09-06

### Added

- **The status line carries the mark** — the amber ⛰ from the favicon, the
  glyph alone, so the line is identifiably ours instead of an anonymous row of
  figures. Two columns, and it is never dropped however narrow the terminal
  gets. This is on every status line, in both modes, and needs nothing turned
  on: if Caprock's status line is already set up, upgrading is enough.

- **The session's own numbers in the Claude Code status line** —
  `N turns · N steps · cache −N% · in N · out N`, from counters only the daemon
  has, added to the line Caprock already prints.

  Nothing to turn on, and nothing to re-register: if Caprock's status line is
  already set up, upgrading is enough, and your settings are not touched. New
  installs get it from `caprock up` as before. `caprock statusline --plain`
  opts out.

  The daemon read that fetches the counters is bounded at 40ms — measured
  against a real endpoint that answers in 0.6ms — and any failure falls through
  to the line you get today. A stopped daemon costs nothing measurable; a hung
  one costs ~55ms per line.

  It is fitted to the terminal — the counters go one at a time, and the plan
  windows are never dropped, being the number that decides whether work can
  continue at all.

  Not shown, deliberately: time to first token, tokens per second, and the
  model-versus-tool time split. Nothing carries them — not the hooks, not the
  transcript — and the obvious derivation from hook timestamps counts your own
  thinking time as inference. They stay off the line until something real backs
  them.

## [0.52.3] - 2026-09-03

### Fixed

- **The loop banner sold a cap that could not act, beside a cost that was not
  the loop's.** Both halves of the row overstated what they knew. The spend cap
  pauses only sessions Caprock started (rule 7), and 122 of the 127 sessions
  that did real work on this machine were started by hand — so "a cap that
  stops this" was, nearly every time it appeared, an offer to stop something
  the cap cannot reach. It now says "a cap covers sessions Caprock starts" and
  offers "what a cap does" unless the session is one Caprock owns; unknown
  ownership counts as not owned, since a promise made on a guess is the thing
  being fixed. The button stays, because the feature is real and the sessions
  where it applies are exactly the ones someone would want it for.

  The figure beside it is the **session's** total, and sitting bare next to
  "Stuck in a loop" it read as the price of the repetition — a $58.85 the loop
  had not cost. Charging the loop's own window instead would not fix it:
  measured on a real two-hour loop, that window held $47 of which essentially
  all was the useful work happening alongside it, so the number would still be
  wrong and harder to argue with (rule 6). It keeps its meaning and now carries
  a visible `session total` label rather than explaining itself only on hover.

  The detector is untouched — it was right, which is how this was noticed.

## [0.52.2] - 2026-09-03

### Fixed

- **Sessions cleared before 0.52.1 still said "compacting context".** 0.52.1
  gave `/clear` and Escape their own event kinds, but only for events recorded
  after it shipped — the rows already in the database kept the compact's kind,
  and on this machine all 18 of them were the *last* event of their session,
  which is the phrase the session card shows. So 17 sessions went on claiming a
  compaction that never happened, and the `/clear` that started the whole
  investigation was still captioned "was compacting context" beside a $1,062
  cost and a 95%-full context.

  A migration reclassifies them. It invents nothing: `events.payload` is stored
  verbatim, so each row already names the hook that produced it, and the rewrite
  reads that rather than guessing — `SessionEnd` with `reason=clear` becomes
  `context.clear`, other continuing reasons become `session.continue`, and a
  genuine `PreCompact` is left alone. No figure moves: these rows carry no cost
  and no tokens, and the totals were checked against a copy of a real 665 MB
  database before and after (identical to the cent).

  Sessions left `active` by an old `/clear` are deliberately **not** closed by
  the migration. Retiring a session whose process is still running is the
  failure [ADR-028](.ai/08-decisions.md) exists to prevent; they age to `idle`
  on their own and close when their process exits.

## [0.52.1] - 2026-09-03

### Fixed

- **`/clear` showed one editor as two working sessions.** Claude Code does not
  end a session on `/clear` — it keeps the process and starts a fresh session
  id inside it. Both rows therefore shared a live pid, and the sweep that
  decides a session is over asks whether its process is still running, so the
  old row could never close. It sat on the dashboard as a second working
  session, frozen at the moment it was cleared, still presenting a six-day cost
  and a 95%-full context as current. The replacement is now keyed off the
  `SessionStart` that follows, which is the only one of the two hooks that
  names the session meant to survive.

- **A cleared session was narrated as "compacting context".** `/clear` was
  stored as `context.compact`, which is a different event: a compact
  summarizes the context and keeps its substance, `/clear` discards it. The
  dashboard reported a compaction that never happened, at the one moment the
  owner is deciding whether to wait. It has its own kind now, and the reasons
  that leave a session running without touching its context (`Escape` at the
  prompt) have theirs.

- **"unknown model" appeared beside the model's own name.** A session that had
  not answered yet has no prompt to measure, so the Context stat was empty —
  and captioned `unknown model` directly beside a Cost stat reading
  `claude-opus-5`. The two reasons a context can be missing call for opposite
  reactions (one clears itself in seconds, the other never will), so the server
  now says which applies, naming the model id when the pricing table cannot
  size it.

- **Fable 5 could not be picked for a new session.** The model list offered
  three ids and omitted the most capable one on the machine, though
  `claude --help` names `fable` alongside `opus` and `sonnet`. All four are now
  offered, ordered by price, each verified by a live answer from the real
  `claude` — `claude-mythos-5` is in the pricing table and stays out, because
  the binary rejects it.

## [0.52.0] - 2026-09-03

### Added

- **A switch for the session memory.** "Sometimes I need the context and
  sometimes I don't" — a fair objection from the first person to live in
  Caprock, who had been bitten by an assistant that remembered his job title
  and volunteered it while he was asking about something else.

  ```
  ☑ Claude knows what you did here last time
    This folder only. Quick chats get nothing.
  ```

  On by default, because most sessions open where work already happened and a
  feature that acts before you type is one nobody finds if it ships off. Turned
  off, it is silent from the next session — not the next restart. Most of the
  worry was already answered by the shape: a quick chat gets a fresh directory
  of its own, so it has no history to be handed, and nothing crosses between
  folders.

### Changed

- **"Answers" is now "Memory".** Two halves of one thing did not know about
  each other: a new session is handed what the last one left, and you can
  search everything the agents ever said. Same corpus — one was labelled
  "memory" in settings, the other "Answers" in the nav, which nobody looking
  for the first would open. The status row names the screen too.

- **The Memory screen says how far back it goes** — "since July 19", measured
  from the oldest passage still held rather than from the fortnight a handoff
  reaches. Those are two different dates, and showing the shorter one
  understated the corpus by a month.

## [0.51.1] - 2026-09-03

### Fixed

- **The token column beside each model counted re-reading, not work.**
  "claude-opus-5 · 12.61B tokens" is arithmetically true and reads as how much
  went through that model. On a normal workload 98.6% of it is cache read — the
  same context fetched again, at a tenth of the price — against 14.6M of output.
  The column measured how many times one conversation was re-read.

  It is **output** now: the model's own work, all of it at the top rate, and
  comparable between models. Beside it, **$/turn** — the only figure in the
  panel that compares models rather than measuring them. A Fable turn costs
  twenty times a DeepSeek one, and no screen said so.

  Cache-read share was the other candidate and is useless: 99% for every model,
  so it distinguishes nothing. The cost column was already right — priced per
  token type, cache reads at their real rate — and is untouched.

## [0.51.0] - 2026-09-03

### Added

- **A session opening a repository you have worked in before already knows
  where you stopped.** Open `claude`, and the agent has been handed the last
  substantial thing an agent said in that repository — no command, no prompt,
  nothing to press. Verified against a live session, which named the previous
  session's work while forbidden to read files or git.

  The first user to live in Caprock for a week, asked why free tools were
  unusable, did not say "no stats" — he said they **lose context**. Measured
  here before anything was written: 120 of 151 sessions (79%) open in a
  repository that already had sessions, 36 of them after more than a day.
  Claude Code keeps only your own prompts across projects and prunes
  transcripts after 30 days; Caprock holds what the *agent* said, since May,
  across 31 repositories. The record was already there — nothing read it back.

  **Recency beat retrieval, which was a surprise.** The first design searched
  prior prose by the words of the opening prompt: it helped in 4 of 15 resumed
  sessions and missed the clearest case there is, because an opening question
  shares no words with its own answer. The last substantial passage answers 12
  of 19, so the clever version is not built.

  Bounded on purpose: only a genuinely new session (not a resume, not after
  compaction — that would be noise growing with the session), at most ~1200
  characters, nothing shorter than 400 ("Done." says nothing), nothing older
  than a fortnight. The text says where it came from, because an agent handed
  an unattributed paragraph treats it as an instruction. Nothing is typed into
  any session: Claude Code asks its hook a question, and this is the answer.

  The status screen says whether it can speak, and for how many repositories —
  a feature that acts before you type is one nobody can otherwise see working.

## [0.50.1] - 2026-09-03

### Fixed

- **The update instructions were set like captions.** The commands read fine;
  everything explaining them was 11px in the faintest grey — the weight this
  interface uses for a timestamp, something you are meant to slide past. It is
  the half of the dialog that says why updating takes three commands and why
  Caprock will not do it for you. The install-route tabs got the same lift;
  they are a choice, and they were dimmer than the platform tabs beside them.

## [0.50.0] - 2026-09-03

### Added

- **Let a tablet in from the dashboard, without a terminal.** Reading Caprock
  from a phone shipped needing `caprock up --lan`, which requires a terminal on
  the machine — and the person who wants this is holding the tablet. It is a
  button on the status screen now, with an off switch beside the device list.
  The flag still works for a machine administered over SSH. Unchanged: it is
  off again when Caprock restarts, and paired devices are kept.

- **Caprock uses a Tailscale address when there is one, and says which kind of
  address you have.** A LAN address works when the other device is on the same
  wifi and *never* from mobile data — no setting changes that, because the
  packets do not arrive. The panel said nothing about it, so the honest
  conclusion from a tablet on mobile data was that the feature is broken.

  It now names the difference under the address, and points at Tailscale for
  the case a LAN address cannot serve. Tailscale's own range (100.64.0.0/10) is
  not "private" by the Go standard library's definition, so the one address
  that solves the problem was being filtered out as public; it is preferred
  over a LAN address when both exist.

## [0.50.0] - 2026-09-03

### Added

- **Let a tablet in from the dashboard, without a terminal.** Reading Caprock
  from a phone shipped needing `caprock up --lan`, which requires a terminal on
  the machine — and the person who wants this is usually holding the tablet,
  not sitting at the machine. It is a button on the status screen now: press
  it, and the same panel shows the address and the code. The flag still works
  for a machine you administer over SSH.

  Everything else is unchanged, including the part that matters: it is off
  again when Caprock restarts, because a laptop opened somewhere you do not
  trust should not carry a decision you made at home. Paired devices are kept —
  they are the guest list, not the open door — and there is an off switch
  beside them.

## [0.49.3] - 2026-09-03

### Fixed

- **"Burn now" says it is measuring instead of extrapolating.** 0.49.1 made the
  rate divide by the time it actually covers, which is correct arithmetic and
  an alarming number: a daemon twenty seconds old showed $3,215/h, because
  twenty seconds of a busy minute extrapolates to that. Until the window has
  been lived through, the tile shows a dash and says it needs ten minutes of
  running — a figure nobody can act on is worse than no figure.

- **A test that asserted a promise the code never made.** One of the night's
  new tests demanded that a healthy terminal subscriber receive 300 of 400
  chunks while another subscriber sat stalled. The buffer is deliberately
  lossy — a reader that falls behind legitimately misses some — so the test
  passed on a fast machine and failed in CI, which is what stopped v0.49.2
  from publishing. It asserts what the code actually promises now: the writer
  finishes and a healthy reader keeps receiving.

## [0.49.1] - 2026-09-03

Six figures that were quietly wrong, found by auditing the parts of the backend
nobody had looked at. Every one was measured against a real database before and
after. **Carries schema migration 0020**, which backfills from your own events;
it ran in a tenth of a second on a 257k-event database.

### Fixed

- **"Files touched" counted whole session lifetimes.** The range filtered which
  *sessions* counted, not which *files* — so a fortnight-long session that
  touched 300 files put all 300 into "today" the moment it said anything today.
  Seven days read 417 against a true 144. The ranged answer was already on
  disk; the wrong table was being asked.

- **The daily session count read zero on days with real spend.** It counted a
  session on the day of its first turn *ever*, so a session begun yesterday
  added nothing to today. Four of eight days read 0 against 1, 2, 2 and 2 —
  beside cost and token figures in the same rows that were correct, which is
  worse than being wrong alone. After the migration, ten recent days all match
  a direct count over the events.

- **A replaced transcript of the same size lost everything below the old
  offset.** Truncation was detected by "the file got shorter", and Claude Code
  rewrites transcripts in place — on a resume, on a compact — where the
  replacement usually is not shorter. Those lines were never parsed, so nothing
  deduplicated them either: a session simply arrived missing its first turns.

- **A half-written Gemini record was skipped permanently.** The reader advanced
  past everything available whenever anything parsed, which is the opposite of
  what its own comment promised. Since the file is read while Gemini writes it,
  landing mid-record is the normal case.

- **Two Gemini events in the same millisecond became one** — and worse, every
  event whose timestamp was missing or in an unexpected format shared a single
  key, so only the first was ever stored.

- **The burn rate divided a partial window by its full width.** A daemon three
  minutes old has three minutes of history and was dividing by ten, so the rate
  read a third of the truth with nothing saying the window was still filling.

- **Six tables can no longer push the page sideways** on a narrow screen. On a
  tablet a wide table took the whole body with it.

### Changed

- **More tests where a failure would cost something**: the three shapes a tool
  error arrives in (only one was exercised, and it decides the red badge), the
  point where rule 7 is enforced, all five pairing handlers, and the file that
  holds device tokens. Every important test was checked by reverting the
  behaviour it asserts.

## [0.49.0] - 2026-09-03

### Added

- **Read Caprock from a tablet.** `caprock up --lan` opens a second listener on
  this machine's own private address; the status screen shows what to open on
  the other device and a six-digit code to type. No account, no tunnel, nothing
  on anybody's server — the other device is talking to your machine.

  Free, and staying free. What premium unlocks are the three things that spend
  money or leave the machine; reading your own figures from the sofa is
  neither, and charging for the one place the local-first promise loosens would
  be a strange thing to sell.

  The pairing rules were built and tested a fortnight ago and are unchanged:
  single-use codes, five minutes, burned after five wrong guesses, a full
  length token that does not expire, and revocation that takes effect on the
  next request. What is new is the listener, the gate and the screens. Every
  request from the network is refused until a device has traded a code for a
  token — the pairing endpoint and the dashboard's own files are the only
  things open before that, and every other path is closed by default.

  Three decisions are worth knowing, because each had an easier wrong answer.
  **`--lan` is a flag, not a setting**: a laptop opened somewhere you do not
  trust should not carry a decision you made at home, so the devices survive a
  restart and the open door does not. **One named address, never `0.0.0.0`**,
  or a VPN or container bridge coming up later would quietly widen it. And the
  **DNS-rebinding defence admits exactly one more host** — the address you
  chose — rather than the whole private range. See
  [ADR-029](.ai/08-decisions.md).

  No QR code: nothing here can verify that a generated one actually scans, and
  an unverified QR is worse than an address you can type in fifteen seconds.

### Fixed

- **Two figures ignored the agent filter.** Choosing `opencode` on the Now
  screen narrowed most of the Today panel and left "burn now" showing every
  agent's money, in the same grid row as the cost it no longer matched. The
  unpriced warning had the same fault, and worse: it told a reader looking at
  one agent that tokens were missing from a total those tokens were never in.

- **The share card's breakdown was always the last thirty days.** Choosing a
  period changed the heading and the lit tile and nothing else that mattered,
  so a card headed "My week on Caprock" carried a month's models beneath it —
  five of them against the one that week ran, and $5,459 of Opus against
  $1,576. The four tiles still show every period on purpose; it is the
  breakdown that belongs to the period the card names.

- **A range or filter change showed the previous answer under the new
  heading.** Pressing 7d while 30d was up swapped the title at once and left
  every figure below it answering the old range until the response landed —
  around half a second on a large database, long enough to read a number and
  believe it. A refresh still keeps the figures on screen, because blanking
  them every few seconds would be its own defect.

- **The calendar put days in the wrong weekday column.** A day nobody worked
  has no row at all, so one missing Sunday slid every later day one column
  left and a Monday rendered under "S" — in a panel whose whole purpose is
  making "I do not work Sundays" visible at a glance.

- **"Ended · 200" counted the page, not the sessions.** The list is capped at
  200, and the label counted the array it received while the lifetime strip
  above said otherwise. It reads "200 of 431" when they differ.

- **The largest figure on the screen called itself a cost.** On a flat plan it
  is not one: it is what the work would have cost through the API, and the
  qualifier saying so sat underneath in grey at a third the size. A reader on a
  subscription took the whole product for an accusation of waste. The figure is
  unchanged and now headed "Worth at API list"; anyone billed per token still
  sees "Cost", because for them it is the true word.

### Changed

- **Every screenshot retaken**, and three faults in how they are captured
  fixed: two first-run banners were in every frame, "set plan" was lit as an
  unfinished action because the capture runs against a throwaway data
  directory, and the feature crops had silently been failing to find their
  panels since the database grew.

- **The docs say what the product does now.** An audit found the release check
  described as the only outbound call (it is one of three, all opt-in), the
  premium page selling a shipped feature as unbuilt, a release runbook asking
  you to verify a hook count that can no longer appear, and Gemini missing from
  every user-facing list of agents.

## [0.48.0] - 2026-09-02

### Fixed

- **Every table says what its columns are.** Three figures in a row with
  nothing over them is a puzzle: `$7,587.14 · 12.01B · 58%` reads as three
  unrelated numbers until you work out which is which, and the "by cost" in the
  corner describes the sort order rather than the columns. Every breakdown on
  Now, Cost and Lifetime now names them, on one line with the table's own title
  so it costs no vertical space.

  The tool table gained a second figure while this was being written; see
  "how much each tool hands back" below.

- **The all-time breakdown moved up, under the live pulse.** It was last, below
  a tall activity feed, so the most legible thing on the screen was the thing
  you had to scroll to find.

- **"Nothing measured yet" appeared while the figures were still loading.** The
  first screen could not tell "no answer yet" from "the answer is nothing", so
  for the second it took the first response to arrive it announced, with
  confidence, that a machine with thousands of turns on it had never run
  anything. It says "reading your figures…" until it knows. Measured on a
  641 MB database: nothing on this screen takes longer than 0.7s, so the delay
  was never the problem — the wrong answer during it was.

- **The answers screen showed raw Markdown.** Claude writes bold text, lists
  and tables; the screen kept the line breaks and showed everything else as the
  markup it is made of — `**bold**` with its asterisks, a table collapsed into
  `| | |`. The same renderer the release notes got now covers both, and it
  learned tables and quotes on the way.

- **A plan you had already chosen looked unchosen.** Once set, the picker's
  button went grey and lost its border — which is exactly what the buttons
  beside it look like when they are not set — so every session started with the
  impression that the plan had been forgotten again. It keeps its border and
  carries a check.

- **A Gemini error sent people somewhere they no longer need to go.** "Set
  GEMINI_API_KEY in the daemon's environment and restart it" — but the key has
  a field on the Cost screen and takes effect at once. A wrong instruction is
  worse than a long one.

- **Errors carried a Go package name into the dialog box.** `agents: "/x" is
  not an absolute path` was written for whoever was debugging it.

### Added

- **The tool table says how much each tool hands back.** Calls alone told the
  wrong story. Bash is 46,343 calls returning 13.4 MB; Read is 11,767 calls
  returning 58.7 MB — four times fewer calls, four times more context. The loud
  tool is the cheap one, and nothing in the product said so.

  In bytes, deliberately, and not tokens. Tool results arrive in the transcript
  with no token attribution of their own, so a token figure here could only be
  invented from a bytes-per-token ratio — and 14% of Bash calls cannot be
  linked to the turn that paid for them against 1% of Read's, so the invented
  number would have understated Bash specifically, which is the comparison the
  table exists to make. Bytes are measured.

  Measured as each event is stored rather than counted per request, with an
  index that covers the query: the all-time figures went from 2.1s to 0.05s on
  a 641 MB database. The panel that took a visible beat to appear no longer
  does, and there is no cache to go stale.

- **Share a week, a month, or today — not only all time.** The picker was
  removed once, on the reasoning that a card showing every period at once made
  choosing redundant. It does not: somebody sharing a working week does not
  want their lifetime total to be the headline, and a card that answers four
  questions answers none of them loudly. The choice now decides what the
  heading claims and which figure is lit; every other period stays on the card,
  because a week means nothing without knowing whether it was a normal one.
  It opens on the week.

- **You can see the card before you send it.** The buttons said where the
  picture would go and nothing said what was in it: you pressed Save, opened
  your downloads, and only then found out. The card is drawn in the sheet now,
  at the size it will be seen, and it redraws as you change the period — which
  is what makes the choice worth having.

- **The Share button can be found.** It was an outlined button in a row of
  11px text, next to a solid premium button — an outline cannot win an argument
  with a fill. It is filled, a size up, and carries an icon. It earns that:
  sharing is the only thing on this dashboard that leaves the machine.

### Changed

- **Copy across the product says less.** Several tooltips explained the
  attribution algorithm where the reader had asked what a number meant, and
  several paragraphs defended design decisions nobody had questioned. The
  longest of them — the per-directory rule — was four sentences of
  specification on hover; it is now one. "Everything here is measured — no
  invented numbers" is gone from the Cost screen: readers assume the figures
  are real until told otherwise, so the sentence created the doubt it answered.

- **Messages about a missing `claude` say what to do.** "Spawning is
  unavailable" named an internal verb and diagnosed without a fix; it now says
  the binary is not on PATH, that installing Claude Code fixes it, and that
  watching works regardless.

## [0.47.0] - 2026-09-02

### Added

- **Pick up a session Caprock did not start.** It never types into a process it
  did not launch — two writers on one terminal interleave characters and ruin
  both — so a session you started yourself was readable here and nothing else.

  There is now a button on it. `claude --resume` starts a *second* process on
  the same conversation, with the history read from disk: nothing is taken away
  from the terminal that already has it, and the new process is one Caprock
  started, so it can be typed into like any other. The stats, the timeline and
  the terminal all work on it.

  While the original is still running the copy branches instead —
  `--fork-session`, a new id — because two live processes sharing one id would
  write a single transcript between them and each end up holding half the
  other's turns. Once it has ended, it simply continues.

  The command is offered for copying too, for people who would rather stay in
  their own terminal.

## [0.46.0] - 2026-09-02

### Added

- **Send this week's report now.** There was no way to find out whether a bot
  token and chat id were right except to wait for Monday — and when nothing
  arrived, that looked exactly like a week where nothing moved. A button beside
  the fields sends one immediately.

  The panel also now says why the bot is yours rather than ours: the message
  goes straight from your machine to Telegram, so your figures never pass
  through anybody's server. A shared bot would mean shipping its token inside a
  public binary and routing what you spend through us to deliver it. And it
  says to write to the bot first, because Telegram will not let a bot message
  you until you have — the step that silently produces an empty `getUpdates`.

### Fixed

- **What's new showed raw Markdown.** `### Fixed` as a literal heading,
  asterisks around every bold phrase, and paragraphs broken at the eighty
  columns a changelog is wrapped to for the sake of diffs. It was rendered as
  preformatted text on the reasoning that a local-first tool should not render
  remote markup — right instinct, wrong conclusion, in a dialog whose only job
  is to be read.

  Not solved with a Markdown library, which would parse arbitrary remote input
  into HTML. Caprock recognises the four shapes its own notes use and builds
  elements from strings: no links, no images, no attributes, nothing that can
  turn remote text into markup, with tests holding that line.

- **The dialog linked to GitHub.** Someone reading what they just upgraded into
  wants the changelog written for readers, not a tag page with build artefacts
  on it. It goes to caprock.dev/changelog now.

## [0.45.2] - 2026-09-02

### Fixed

- **Why a weekly report never arrived is remembered now.** The reason a send
  failed was held in memory, so restarting the daemon erased it — and
  restarting is exactly what somebody does when a feature seems broken, which
  made investigating the problem the thing that destroyed the evidence.

  This matters more than it sounds because of how the feature fails: a message
  that stops arriving is an absence, and nobody notices an absence. The
  settings panel was the only place the reason appeared, and it was empty by
  the time anyone looked. Telegram's own words — "chat not found", "bot was
  blocked by the user" — are kept, because both are things only the user can
  fix, and a week later they are still the answer.

## [0.45.1] - 2026-09-02

Both found by installing Caprock from scratch and reading the first screens the
way somebody seeing it for the first time would.

### Fixed

- **The premium lock covered the sentence explaining the feature.** The caption
  and the button were centred on the panel, so they landed exactly across the
  middle of the text — "Off. Nothing is paused, whatever the day costs" was cut
  mid-word by the thing selling it. Two earlier attempts tuned the preview's
  opacity, which could not help: the problem was never how transparent the
  overlay was, it was where it sat. It is a row underneath now, reading in the
  order the eye already moves — here is the feature, here is what it costs —
  and covering nothing.

- **A `gemini` filter chip appeared on a machine with no Gemini sessions.**
  Having the binary on PATH is what decides whether the New Session dialog
  offers Gemini; it says nothing about whether any Gemini session exists. A
  first run showed `all · claude · gemini` above an empty screen with nothing
  to sort by. The chip now appears when there is something to filter.

## [0.45.0] - 2026-09-02

### Changed

- **A session stays open until its process exits.** It used to close after a
  stretch of silence, and every number chosen for "a stretch" was wrong for
  somebody: twelve hours left the day's work marked live at midnight, and one
  hour closed a session while its owner was at lunch. Both were guesses about a
  person's day standing in for a fact about a process — and the fact is
  available. The shim now reports the pid of the Claude Code that ran it, and
  Caprock already knew the pid of every session it starts itself, so the sweep
  asks whether that process is alive instead of watching a clock.

  A session you leave for a week is still there when you come back. One whose
  terminal you closed ends on the next sweep, without waiting for a threshold
  at all.

  A staleness threshold still exists for sessions with no pid to ask — rows
  written by an older shim, and transcripts read with no live process behind
  them — and it is now twenty-four hours, because there is nothing to verify
  and the only cost of being slow is a stale row in a list.

  **OpenCode sessions are judged by the clock alone**, never by liveness. They
  are read out of OpenCode's own database rather than watched, so there is no
  process of ours behind them and they arrive already old. The first cut of
  this change missed that and filled the screen with 97-day-old sessions marked
  live.

### Fixed

- **The Now screen shows now.** A session that has not made a sound in two days
  no longer appears there, whatever its status column says — status alone
  cannot tell a quiet session from somebody's history, because an observed
  agent's sessions arrive weeks old by definition. Two days rather than one, so
  a session left on Friday evening is still on screen on Monday morning.
  Anything actually working shows regardless of age, which is what the screen
  is for. Older sessions are on Lifetime and under "show ended".

## [0.44.5] - 2026-09-02

### Fixed

- **A session you left for lunch was closed while you were out.** 0.44.3 cut
  the staleness threshold from twelve hours to one, on the reasoning that an
  hour outlasts lunch. An hour *is* lunch: the first person to leave a terminal
  and come back to it found the session gone from the dashboard. On the machine
  this was checked against, 44 sessions had paused for over an hour and then
  carried on working, and 86 of those pauses were between one and three hours —
  a meeting, a walk, an afternoon on something else.

  Eight hours now. The threshold only exists to catch a session that ended
  without saying so — `kill -9`, a closed terminal, a crashed host — because
  `SessionEnd` ends an ordinary session the moment it ends. So it can afford to
  be slow, and the two mistakes are not symmetric: a stale row costs a line in
  a list until the next sweep, while one wrongly ended vanishes from the
  dashboard with its owner still working in it.

## [0.44.4] - 2026-09-02

### Added

- **Caprock now sees what a Gemini session does.** It could start one and then
  observe nothing: a live session sat in the list with zero turns, zero tokens
  and no cost. Gemini has no hooks and writes no transcript, but it does write
  OpenTelemetry, and it will write it to a file Caprock names — so a spawned
  session now reports its turns, its tokens and its cost like any other.

  The file is per-session, named by the session id, and lives in Caprock's own
  data directory rather than in your project, where it would be something to
  gitignore. Prompts are switched off in it: what you typed is on screen in the
  terminal already, and a second copy on disk is one nobody asked for.

  Cache writes stay at zero for Gemini. It reports what it read from cache and
  has no equivalent of Claude's cache-write figure, and a column that means "we
  do not know" is better empty than filled with a guess.

### Fixed

- **Two of the three Gemini models still could not be used.** The list was
  checked against the installed CLI and the pricing table, and both said these
  were fine. A real key says otherwise: Google has closed
  `gemini-2.5-flash-lite` to new keys, and `gemini-3.1-pro-preview` is barred
  on a free key by quota (`generate_content_free_tier_input_token_count,
  limit: 0`) — so picking either opened a terminal and then failed.

  The three offered now each answered a real prompt on a real key, and are
  priced. This is the third pass over one short list: written from memory,
  then checked against the CLI bundle, and only the live call was right.

## [0.44.3] - 2026-09-02

### Fixed

- **A session you were still working in could close itself.** 0.44.0 started
  listening to Claude Code's `SessionEnd` hook so a session ends the moment it
  ends rather than whenever the staleness sweep next runs. But `SessionEnd`
  does not only mean "the user left": it also fires on `/clear`, on Escape at
  the prompt, and with an unhelpful `other`. All of them were being treated as
  the end. One session on the machine this was found on had been running for
  six days when a `/clear` retired it in the dashboard.

  Only a reason that actually means an exit ends the session now. A `/clear` is
  recorded as the context reset it is, so it still appears in the timeline. A
  process that really exits is unaffected — that path records the exit code and
  never consulted the reason.

  The two mistakes here are not symmetric, and the fix leans accordingly: a
  session wrongly left open closes itself within the hour, while one wrongly
  closed vanishes while its owner is still typing into it.

## [0.44.2] - 2026-09-02

Both of these came from the first person to run a Gemini session in anger.

### Fixed

- **The terminal flickered on every keystroke.** A `ResizeObserver` called
  `fit()` straight from its callback, and `fit()` writes to the element the
  observer is watching — so a resize could cause a resize. Idle, that settles
  after one frame and nobody notices. Under a TUI that repaints its whole box
  on every key, which Gemini CLI does, it was a visible flicker on every key.
  Fits are now coalesced into one per frame and skipped entirely when the
  geometry has not moved. It affected any terminal that repaints often, not
  only Gemini's.

- **Six columns of zeros above a session Caprock cannot measure.** A Gemini
  session showed `$0.00`, `0` tokens, `0` turns, `0%` cache, with the reason —
  "no hooks · no transcript" — in small grey text underneath. Zeros are how
  that bar says "nothing has happened yet", so it read as broken rather than as
  out of scope. It now says the one true thing instead: Caprock started this
  session but does not measure it, and the terminal below is live.

## [0.44.1] - 2026-09-02

### Fixed

- **Starting a session with Gemini actually works now.** 0.44.0 shipped the
  feature built against a fake binary, on four assumptions about the Gemini CLI
  that were written from memory rather than from `gemini --help`. Installing the
  real thing disproved all four in ten minutes.

  *It stopped before it started.* Gemini refuses to run in a directory it has
  not been told to trust, and inside a terminal nobody is watching that is an
  invisible hang, not an error. Caprock passes `--skip-trust` — sound here
  because the only directory it ever launches is the one picked in the dialog,
  which is the same consent the prompt asks for.

  *Two of the three models did not exist.* `gemini-3.5-flash-lite` and
  `gemini-3.7-flash` were invented; the session would open a terminal and then
  die at the binary. The list now offers only ids the installed CLI recognises
  and the pricing table can cost, and a test holds that line.

  *Permissions were greyed out as "not used by Gemini".* Gemini has four
  approval modes and the dialog was throwing the choice away. They map onto
  Claude's: accept-edits to `auto_edit`, bypass and auto to `yolo`, plan to
  `plan`. Claude's `manual` and `dontAsk` have no counterpart worth guessing at,
  so they are marked in the list and Gemini falls back to asking.

  *`--session-id` was omitted on the belief Gemini did not accept it.* It does,
  so the row in the sessions list and the session the agent thinks it is in are
  now the same one.

- **A Gemini session is no longer described as a Claude one.** The agent was
  added to the launcher and to nothing else: its sessions arrived in the list
  wearing no badge, with no filter chip to find them by, and the empty state
  called them Claude Code — because three separate places asked
  `agent === 'opencode'` and treated everything else as Claude. There is now a
  `gemini` chip beside `claude` and `opencode`, shown only on a machine that has
  it, and one helper decides the badge and the name so a fourth agent cannot
  reintroduce this.

  Caprock still does not *watch* a Gemini session — no hooks, no transcript, so
  its turns and cost are absent from every figure. Starting it is control, not
  observation; the README says so rather than leaving it to be discovered.

## [0.44.0] - 2026-09-02

### Added

- **Start a session with Gemini CLI.** Install it
  (`npm install -g @google/gemini-cli`), and it appears next to Claude Code in
  the New Session dialog — same terminal, same directory picker, same row in the
  sessions list, same cost stream. Caprock passes the key you already entered
  into the child process, so it works without exporting anything in the shell
  you happen to be in.

  The previous release let a Gemini key answer questions *about* your spending.
  That is not what somebody with a key wants it for — they want to work with the
  model, and the panel answered questions about the tool instead of doing the
  job. Both now run on the same key.

  The two CLIs do not take the same flags — Gemini has no permission modes and
  no caller-assigned session id — so picking the agent switches the model list
  and greys out Permissions rather than sending an argument the binary rejects.
  The picker is hidden entirely on a machine with no `gemini` on PATH.

### Fixed

- **A debounce timer outlived the screen that set it.** Closing a screen inside
  the 400 ms live-tick window left a timer that woke up and set state on a
  component that no longer existed. It was visible mainly as a failed release —
  the timer firing after the test runner had torn the DOM down, with all 483
  tests passing — which is how it got fixed twice at the wrong end before the
  cancel-on-unmount that it actually needed.

## [0.43.0] - 2026-09-02

### Added

- **Claude Fable 5.1 and Mythos 5.1 in the pricing table**, contributed by
  [@SergeAx](https://github.com/SergeAx) — the first outside contribution to
  this repository. Cache reads on those two models cost 0.025× the input price
  rather than the 0.1× every other Claude row follows, which makes `$0.25` look
  like a typo of Fable 5's `$1.00`; the PR pins it with a test, so a later tidy
  cannot quietly charge four times the real rate.

### Changed

- **`fetched_at` in the pricing table names the most recent read**, and each
  note carries the date for the rows it describes. One date on a table
  assembled from three vendors over three weeks said 18 August while holding
  prices read on 1 and 2 September — which tells a reader checking a figure
  nothing about that figure.

- **The Gemini key goes in the dashboard now.** It was read only from
  `GEMINI_API_KEY`, on the reasoning that a key Caprock never holds is one it
  can never leak — but a daemon started at login inherits nothing from a shell
  profile, so switching on a paid feature meant hand-editing a launchd plist.
  A key nobody can enter protects nothing; the feature just goes unused. Paste
  it into the panel instead. The environment variable still works and still
  wins where both exist, and the stored key is never returned by any endpoint —
  the same write-only rule the Telegram token follows.

## [0.42.1] - 2026-09-01

### Added

- **The weekly report, to your own Telegram bot.** What moved this week against
  your usual, sent Monday morning — or the next day you open the lid, because a
  timer set for Monday 09:00 fires for nobody whose laptop is shut at weekends.

  A repository is only named when it clears both a real change in dollars and
  twice its usual week, where *usual* is the median of the preceding four weeks
  rather than last week: $2 to $6 is three times and is nothing, and a claim in
  a message is one the reader cannot click into to check. Most weeks it says
  nothing moved, which is true and worth saying. A week the machine was off is
  reported as such rather than as a collapse in spending.

  The bot token is stored on your machine and is the one thing this API accepts
  but never returns. The message carries figures only — no prompts, no replies,
  no tool output, no file names — and goes straight to Telegram; nothing passes
  our server.

### Fixed

- **A setting no longer resets when you save a different one.** "Set plan keeps
  resetting" was not a save that failed: the dashboard sent the whole settings
  object every time, assembled from a cache in the page, so any control could
  write back a field it had read minutes earlier. Two tabs were enough — change
  the plan in one, turn on update checks in the other, and the second restated
  the plan from its own stale copy. Only what changed is sent now.

- **Live activity showed a fortnight of history as what just happened.** Two
  causes at once: the feed asked for a session's *first* sixty events rather
  than its last, and the store ordered "most recent" by insertion rather than by
  time. Those agree for a session captured live and diverge for one whose
  transcript was re-read, because a backfill inserts old events with new ids. On
  a long session every row was equally stale, which is also why it read as
  impossible to scroll.

- **The new-session dialog cut off the permission label** — "Accept edits · asks
  before com…" hid the consequence, which is the one thing that label exists to
  state. Wider dialog, shorter labels.

- **A stray reconnect no longer crashes a torn-down page.** The live socket
  queues a retry when it cannot connect, and that timer could outlive the
  document that scheduled it — harmless in a browser, where the page is going
  away anyway, and enough to fail a release build whose every test had passed.
  It now gives up quietly instead.

- **The premium chip was two controls disguised as one.** The label went
  straight to the checkout while a chevron beside it opened the explanation, in
  one border with no seam between them — so clicking the word "premium" to find
  out what premium *is* took you to a card form. One control now: it opens the
  dialog, and once you have bought it names your plan and when it ends.

## [0.41.0] - 2026-09-01

### Added

- **Ask Gemini, on your own key.** The second paid feature: a second model
  inside Caprock, billed to you by Google at their prices. Caprock **never
  stores the key** — it reads `GEMINI_API_KEY` from the daemon's environment at
  the moment of the call, and it is never written to disk, never accepted by the
  settings endpoint and never returned by one. A key we do not hold is a key we
  cannot leak; the cost is that you set a variable and restart, which the panel
  says plainly.

  Questions travel with your own figures — today's and the week's spend, the top
  models and projects, what is running now — so the answers are about your
  machine rather than about software in general. Prompts, replies, tool output
  and file paths are never sent.

  The model is yours to pick, priced before you spend: a question costs about
  0.04 cents on Flash Lite and 1.00 cent on Pro. Answers are counted and priced
  beside your Claude spend, from the response's own token counts — which is what
  Caprock sent, not what Google billed, since there is no per-key billing API to
  reconcile against.

  **Not yet exercised against the live API.** The token fields are taken from
  Google's documentation and every path is covered by tests against a stubbed
  endpoint, but no request has been made with a real key — so if Google names a
  usage field differently, a question would be recorded as costing nothing.
  Setting `GEMINI_API_KEY` and asking one question is what confirms it.

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
  metaphor for a mechanism, and the verdict on it was "unclear". A banner has
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
