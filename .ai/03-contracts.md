# Caprock — Contracts

The wire-level and on-disk contracts: hook shim protocol, HTTP API, WebSocket frames, SQLite DDL and migrations, pricing table, runtime file, and the observed transcript shape. This file is the canonical home for every contract; other files link here instead of restating. Hive-side file formats (task files, mailbox messages, ledger) live in [05-orchestration.md](05-orchestration.md).

Conventions that apply to every contract here: JSON casing is **snake_case**; all money is **USD float**; all tokens are **int64**; everything is versioned under **`/v1`** from day one.

## Hook shim

- Single Go binary `caprock-hook` (same repo, tiny), installed to Caprock's data dir.
- Registered in `~/.claude/settings.json` under events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`, `PreCompact`, `StopFailure`. Installer merges JSON non-destructively; `caprock hooks uninstall` reverts; back up the settings file before first write.
- Behavior (Phase 0–1: fire-and-forget): read stdin JSON → POST to `http://127.0.0.1:<port>/v1/hook` with `Authorization: Bearer <run-token>` and `X-Caprock-Ppid: <os.Getppid()>` → always exit 0 within a 1s budget. Never print to stdout (a broken shim must not affect the user's Claude session). If the daemon is down, drop silently.
- One server, one port: `/v1/hook` lives on the same listener as the API and UI (default **4173**); `<data_dir>/runtime.json` holds `{port, token}`, written by the daemon, read by the shim per invocation.
- Phase 2 extended this protocol for **Stop events only** — request-response with a 5s timeout; see [05-orchestration.md § Stop-hook decision protocol](05-orchestration.md#stop-hook-decision-protocol-shim-upgrade-t19).
- Why a shim binary rather than Claude Code's native `type: "http"` hook: [ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type).

### Hook payload (what the shim forwards, verbatim)

Claude Code sends one JSON object per event on the shim's stdin. Fields common to all events (per the hooks reference, verified 2026-08-18): `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `effort` (`{level}`), and for subagents `agent_id`, `agent_type`. Event-specific fields the daemon reads:

| Event              | Fields consumed                                              |
| ------------------ | ------------------------------------------------------------ |
| `PreToolUse`       | `tool_name`, `tool_input`, `tool_use_id`                     |
| `PostToolUse`      | `tool_name`, `tool_input`, `tool_use_id`, `tool_response`    |
| `UserPromptSubmit` | `prompt`                                                     |
| `Stop`             | `stop_reason`, `last_assistant_message`                      |
| `SubagentStop`     | `stop_reason`, `last_assistant_message`, `agent_id`          |
| `SessionStart`     | `source` (`startup`, `resume`, `clear`, `compact`, `fork`)   |
| `SessionEnd`       | `reason` (payload stored; the event itself ends the session) |
| `PreCompact`       | `trigger` (`manual`, `auto`)                                 |
| `StopFailure`      | `error` / `stop_reason` (rate_limit, overloaded, billing)    |

The daemon stores the raw payload untouched in `events.payload`; unknown events and unknown fields are logged and ignored, never fatal ([06-engineering-rules.md](06-engineering-rules.md)).

**Dedupe keys.** hookd keys events as `pre:<tool_use_id>`, `post:<tool_use_id>`, `prompt:<prompt_id>`; ingest derives the *same* keys from transcript `tool_use` / `tool_result` blocks and `promptId`, and keys assistant turns as `msg:<message.id>`. `(session_id, key)` is unique in the store, so whichever plane arrives first wins and the other is a no-op — this is how "dedupe against hook events by session_id" is implemented, and it also makes re-reading a transcript after restart idempotent. Stop / SubagentStop / SessionStart / SessionEnd / PreCompact are keyless (never deduped).

### settings.json registration shape

The installer writes, for each of the nine events, a matcher-less entry (`matcher` omitted — `UserPromptSubmit` and `Stop` do not accept matchers) of the form `{"hooks":[{"type":"command","command":"<data_dir>/caprock-hook","timeout":5}]}` and leaves every other key, every pre-existing hook, **and the user's key order** untouched (ordered-JSON merge). The registered command is written with **forward slashes and double quotes**, on every platform: Claude Code runs hooks through a POSIX shell, where a backslash is an escape, so a Windows path reached it as `C:UsersVolasAppData…caprock-hook.exe` and every hook failed while the dashboard — still fed by transcript tailing — looked healthy. Windows accepts forward slashes in every API, and the quotes keep a path with a space (`C:/Program Files/…`, or the macOS `~/Library/Application Support/…`) from splitting into two words. Either fix alone is insufficient. `statusLine.command` is written the same way and had the same defect. Entries in any earlier form — bare, quoted, backslashed — are still recognised as ours, so an upgrade neither reports a working install as missing nor overwrites a line the user repaired by hand. When no `caprock-hook` binary sits beside the `caprock` executable, the registered command is `<caprock> hook` (a hidden subcommand running the same shim code). Uninstall removes only entries whose `command` points at a Caprock shim (exact path, or basename `caprock-hook[.exe]`, or `<caprock> hook`) and drops empty containers it leaves behind. Backups are `settings.json.caprock-backup-<unix-ts>` next to the original, taken before a modification **whenever the current content is not already captured by an existing backup** — a backup taken once and never refreshed goes stale (the audited machine had a 10 July snapshot of a file last edited 20 August) and would restore a file the user no longer recognises. Identical content is never snapshotted twice, so repeated runs over an unchanged file add nothing. A same-second second backup gets a `-2` suffix rather than overwriting its predecessor. At most 5 are kept: the oldest (the closest thing to a pre-Caprock state) plus the most recent 4. `caprock hooks restore` lists them and restores one by path, snapshotting the current file first so the restore is itself undoable; it refuses an unparsable backup. An unparsable settings.json is never modified.

## HTTP API (daemon, `127.0.0.1:4173`)

### Who may connect, and from where

Loopback by default and nothing else. `caprock up --lan` opens a **second**
listener on one named private IPv4 address — never `0.0.0.0` — and from that
moment one rule decides every request: **anything that did not come from this
machine must carry a device token** ([ADR-029](08-decisions.md)).

- **Loopback is unaffected.** No token, no change, no existing client touched.
- **From the network, three things are reachable without a token:** `POST
  /v1/pair`, the dashboard's own files (they carry no figures), and nothing
  else. Every other `/v1` path is closed by default, so a route added later is
  private until someone decides otherwise.
- **The token is a header**, `X-Caprock-Device`, or — on `/v1/live`, where a
  browser cannot set one — the WebSocket subprotocol `caprock.device.<token>`,
  echoed back to complete the handshake. Never a query parameter: that writes a
  bearer token into every access log and browser history entry on the device.
- **`--lan` is a run flag, never stored.** Paired devices survive a restart;
  the decision to listen does not.
- **Refusal is `401` with `{error, detail}`**, not a redirect — the caller is
  usually `fetch()`, and a redirect to HTML becomes a parse error three frames
  later.

**Pairing endpoints.** `GET /v1/pair/state`, `POST /v1/pair/code` and `DELETE
/v1/pair/devices/{id|all}` are **loopback-only, enforced in the handler** rather
than by the gate: a paired tablet is somewhere to read figures, not a second
control room, and it must not be able to admit a third device or revoke the
laptop that let it in. `POST /v1/pair` takes `{code, name}` and returns
`{token, id, name}`; it is the one call a device makes before it is trusted, and
it answers the same way for a wrong, expired, exhausted or never-issued code,
because every distinction tells a guesser how close they are.

Codes are six digits, single-use, valid five minutes, and burned after five
wrong guesses (`internal/pairing`, unchanged since it was written). Device
tokens are full length and do not expire; revocation takes effect on the next
request. The guest list lives in `devices.json` at mode 0600, beside the
licence key and the report bot token, and never in `config.json`.

### Cross-site request protection

**Binding to loopback is not an authentication boundary against a browser.** Any page the user visits while the daemon runs can send requests to `127.0.0.1`; the same-origin policy stops that page *reading* the response, but not *sending* the request and not what the request does. `POST /v1/agents` executes a command from its body, so an unguarded forgery is remote code execution from a web page.

Guarding only a *present* cross-site `Origin` — the shape `if o != "" && !isLoopbackOrigin(o)` — is therefore wrong, and was the live defect: browsers omit `Origin` entirely on cross-site **simple requests** (an HTML form POST, or `fetch` with a `text/plain` body), so the check was skipped in exactly the case that mattered. **A missing `Origin` is never trusted for a state-changing method.**

When `--lan` is on, the loopback tests above admit **exactly one further host**: the private address the daemon was told to bind. Not the private range — the rebinding defence exists to stop a name an attacker controls from resolving to an address we answer on, and admitting 192.168/16 would leave that open for every address in it.

Every request under `/v1` passes `checkOrigin` (`internal/api/csrf.go`) before routing. The layers, in order:

- **`Sec-Fetch-Site`** — sent by every current browser and not settable by script, so it is the one signal a forgery cannot fake. `cross-site` or `same-site` is refused on **every** method, reads included: a foreign page must not read the session list either. `same-origin` and `none` (an address-bar navigation or bookmark) are the dashboard itself.
- **`Origin`** — when present it must be loopback. Parsed as a URL rather than prefix-matched: `http://localhost.evil.example` has the right prefix and is not loopback, so the earlier `strings.HasPrefix` form accepted any hostname an attacker registered under a `localhost.` or `127.0.0.1.` label.
- **`Host`** — must name this machine, checked only when the request is browser-shaped (`Origin` or `Sec-Fetch-Site` present). This is the DNS-rebinding case: a hostname the attacker controls, pointed at `127.0.0.1`, is genuinely same-origin with the daemon and passes every check above, but the `Host` header still carries the attacker's name. It is not applied to non-browser clients, which legitimately address the daemon by other names (a tunnel, a test harness) with no rebinding risk.
- **A bearer token, or `Content-Type: application/json`** — required on a state-changing method that carries no browser provenance at all. Either one is sufficient. The per-run token lives in `runtime.json` (mode 0600) and a web page can neither read nor guess it. A JSON content type cannot be set by a cross-site *simple* request: doing so forces a CORS preflight, which this server approves for nothing, so the real request is never sent — while a form POST is limited to the three simple content types and so cannot reach the endpoint at all.

**`POST /v1/paste` takes base64 inside JSON, not a raw body — and that is the security design.** A browser hands over an image's bytes and never a path (there is no path for something copied out of a screenshot tool), while Claude Code reads files by path, so the bytes have to become a file. That makes this the one endpoint that writes to disk on a web page's say-so.

`image/png` is a *simple* content type, so a raw upload would have been reachable by any page in the browser without a preflight. Wrapping the bytes in JSON puts the endpoint behind the same forgery guard as everything else, at the cost of a third more bytes. The type is checked against an **allow-list** (png, jpeg, gif, webp, pdf, plain text), the file is capped at **10 MB**, and **the filename is generated entirely by the daemon** — a timestamp, random bytes, and an extension from the table — so nothing a caller sends reaches the filesystem. Files land in `<data_dir>/paste/`. Returns 501 when the daemon has no data directory.

**`WS /v1/agents/{id}/term` carries two things, told apart by frame type.** A **binary** frame is what the user typed, written to the PTY byte for byte. A **text** frame is a control message — today only `{"resize":{"cols":N,"rows":N}}`, which resizes the PTY; a non-zero pair is required and anything else is ignored.

Everything on this socket used to be treated as keystrokes, so there was no way to tell the daemon the window had changed size: `Resize` was declared on the interface and called by nothing, and a PTY kept the size it was born with — 120×40 by default — for its whole life. Claude Code lays its menus out to the terminal size, so on any other window it drew an interface for a screen that was not there. Arrow keys moved a selection nobody could see, which is what the first user reported as "only Enter works".

A text frame that is not valid control JSON is still written through as input, so a dashboard that predates this against a newer daemon keeps typing rather than going mute.

`GET`/`HEAD`/`OPTIONS` are otherwise permissive because every `GET` route on the router is a query. The two that reach a live process — `WS /v1/live` and `WS /v1/agents/{id}/term` — are WebSocket upgrades guarded by coder/websocket's `OriginPatterns`, which already refuses a missing or foreign `Origin`. **A new `GET` with a side effect belongs behind a `POST`**, not on the safe-method list.

Non-browser clients are unaffected, and each in-repo client was checked against its real request shape: the hook shim and `caprock statusline` send JSON + a bearer token, `caprock down` sends a bearer token with no body, `caprock task create` sends JSON, and `caprock tasks`/`status` are plain reads. The dashboard's single mutation helper (`ui/src/lib/api.ts`) already sets `Content-Type: application/json`. `curl` with `-H 'Content-Type: application/json'` works as documented.

### Phase 0

```
GET  /v1/sessions?active=true          → SessionSummary[]
GET  /v1/sessions/{id}                 → SessionDetail (stats + last N events)
GET  /v1/sessions/{id}/events?after=…  → Event[] (paginated; newest=1 returns the tail)
GET  /v1/sessions/{id}/notes           → AssistantNote[] — what Claude said, newest first
GET  /v1/notes?q=…&before=…            → AssistantNote[] — search that prose across sessions, paged
GET  /v1/sessions/{id}/diff            → { files: FileDiff[] } | 409 not-a-git-repo
GET  /v1/stats/summary?range=today     → totals: tokens, cost, sessions, models
GET  /v1/settings                      → user-stated settings (plan, update checks)
PUT  /v1/settings                      → store them
GET  /v1/update                        → cached release status (no network I/O)
POST /v1/update/check                  → check now (403 unless enabled)
GET  /v1/stats/daily?days=30           → DailyStat[]
POST /v1/hook                          → 204 (shim only, bearer-token gated)
WS   /v1/live                          → server-push frames: {type:"event"|"session"|"alert", data:…}
```

`GET /v1/status` gained `platform` (`GOOS/GOARCH`) — the first thing a bug report needs and the last thing anyone remembers to include.

The dashboard route `#/session/{id}?at=<unix-ms>` reveals a moment in the timeline (used by the pulse); it is a client-side concern and needs no endpoint.

**`GET /v1/sessions/{id}/events?newest=1` returns the tail rather than the head**, oldest-first within the page. Paging from the start is right for a timeline read forwards and wrong for anything showing recent activity: on a session with thousands of events, `after=0` hands back the first few hundred — hours old — so a caller asking "what just happened" renders an empty window with no indication why.

**An unmatched `/v1/` path is `404` with a JSON body**, not the dashboard. The UI is served from `/` so client-side routes resolve, which previously meant any unknown API path fell through to `index.html` — a caller that mistyped an endpoint, or used one removed in an upgrade, got `200` and a document, then failed later parsing HTML as JSON. Page routes (`/`, `/cost`, `/session/{id}`) still serve the SPA.

**`GET /v1/stats/daily?days=N` clamps `N` to the ceiling (3650), not to the default.** An out-of-range value used to fall back to 30 days, so a caller asking for everything received a month with nothing indicating truncation — summing that endpoint against `/v1/stats/summary` on a real database disagreed by $1,603. `days` unset, zero, or unparsable still means 30.

Added during T6 (same conventions; not in the spec's list):

```
GET  /v1/events?after=…&limit=…        → Event[] across all sessions (live-feed catch-up)
GET  /v1/status                        → daemon status: version, pid, uptime, data dir, pricing, ingest, hooks
GET  /v1/pricing                       → the pricing table in force
GET  /v1/premium                       → what the paid plan costs and where to buy it
POST /v1/shutdown                      → 200 (bearer-token gated; `caprock down`)
POST /v1/statusline                    → 204 (bearer-token gated) {session_id, five_hour?, seven_day?} — records rate-limit windows
GET  /healthz                          → {status:"ok", version}
WS   /v1/live                          → first frame is {type:"hello", data:{server_time}}; a "session" frame carries {session, stats}
```

`/v1/sessions/{id}/notes` and `/v1/notes` return `AssistantNote[]` — `{event_id, session_id, project, ts, model, text, fragment}` — the prose Claude wrote, as opposed to the tool calls it made. Three rules are baked into the query rather than left to callers. **Subagent sidechains are excluded** (`agent_id = ''` and `payload.sidechain IS NOT 1`): about 45% of assistant turns are subagent chatter, so an unfiltered "what did Claude say" answers with a subagent's words roughly half the time. **`fragment` marks a note shorter than 240 runes** — mid-thought asides like "Let me check that" — so a caller can avoid presenting one as a session's conclusion; ~60% of all notes are legitimately short, so the flag qualifies a *final* note and must never be used to hide prose. **Search matches Claude's prose OR the prompt that produced it** — people remember their own question ("the SSO thing") far better than Claude's phrasing of the answer, so searching only the reply misses how memory works. Only the nearest preceding `turn.user` within a short event window counts, or every reply in an exchange would match rather than the passage that answers it; the row returned is always Claude's reply. **Wildcards are escaped**, so a query containing `%` or `_` matches literally; the corpus is one developer's own sessions, so a scan is cheap and avoids an FTS table that would need rebuilding for historical rows.

`payload.text` on `turn.assistant` is capped at **16000 runes** (`ingest.MaxAssistantText`), clipped on a rune boundary. Parser schema v1 capped at 2000 **bytes** and sliced at an arbitrary offset, which cut multi-byte prose at roughly half the intended length and left `U+FFFD` at the end of about a fifth of clipped rows — disproportionately on closing summaries. `ingest.SchemaVersion` is therefore **2**, and a daemon started against a v1 database re-derives the affected rows once from the transcripts still on disk (`ingest.RepairAssistantText`), rewriting only `payload.text` and leaving every other key, event id, and cost untouched. Rows whose transcript is gone keep what they have. Extended thinking is never stored at all — only `type: "text"` blocks are read — so this content cannot leak Claude's reasoning.

Five indexes exist purely for read speed, created by migrations 0006 to 0010: `idx_events_kind_ts` (kind, ts) and `idx_events_cost_cover`, which additionally carries `model`, `session_id` and the token/cost columns so the summary aggregates are answered from the index without touching the table. Together they take `/v1/stats/summary?range=all` from ~820ms to ~340ms and `/v1/history` from ~830ms to ~470ms on a 184k-event database, for roughly 30MB of index on a 306MB file. `idx_events_session_id` (session_id, id) serves the per-session event lookup behind Now, and `idx_events_kind_id` (kind, id) serves the Answers screen — both order by id, which the ts-ordered indexes cannot satisfy, so without them SQLite read every matching row and sorted it in a temp B-tree to return the newest few. `idx_events_ts_model` (ts, model, cost_usd) serves the model mix, which every summary computes: `idx_events_cost_cover` carries `model` but leads on `kind`, so a ts-only filter cannot use it — 146ms against 56ms over 30 days on a 190k-event database.

Note-**search** deliberately still scans: an FTS5 index answers in 6ms against ~165ms, but it matches whole words, so searching `chestr` finds 394 rows with LIKE and 0 with FTS. People search their own sessions for fragments — half an error message, part of a path — and a faster search that misses them is not the same feature.

Anything added to the summary aggregates should either use these columns or extend the covering index — a column outside it costs the Go driver a table fetch per row, which is far more expensive than the same SQL timed in the sqlite3 shell suggests.

`ListEvents`, `EventsAfter`, `SessionNotes` and `SearchNotes` all clamp `limit` to `MaxEventPage` (5000) instead of falling back to a small default, which made a caller asking for everything receive a fraction of it — `notes?limit=5001` returned 200 rows where `limit=5000` returned 2372.

Plan-limit windows relayed by `caprock statusline` are **validated before storage**: a percentage outside 0–100, or a reset more than eight days ahead, is dropped rather than recorded. A reset already in the past is kept — that is a legitimately stale sample, and the dashboard labels it as such instead of formatting it as a clock.

`GET /v1/status` carries `ingest_error` — the terminal error that stopped transcript ingest, when one happened — and omits it while ingest is running. The tailer runs in a goroutine whose failure used to be logged and swallowed, so a fatal ingest error (a read-only `~/.claude` reproduces it) left the daemon reporting healthy, `caprock status` printing `backfill done`, and the dashboard showing its "No sessions yet — start `claude` in any terminal" empty state forever, while nothing was being captured at all. `caprock status` and the Now and Status screens all report it.

`/v1/stats/summary` and `/v1/history` carry `unpriced` — `{turns, tokens, models[]}` — the volume in range whose model has no row in the pricing table, and which models caused it. It is **omitted entirely when everything in range was priced**, which is the normal case. A model missing from the table leaves `cost_usd` NULL (the rollup logs "model not in pricing table; cost left unknown"), and every aggregate flattens NULL with `COALESCE(SUM(cost_usd),0)` — so tens of thousands of tokens of an unpriced model summed to exactly `$0.00` and rendered as a confident, indistinguishable-from-free number. That is an invented number (rule 6), and it is certain to occur the day a model ships newer than the pricing table, or on a gateway whose model ids do not normalise. The models are **named**, not merely counted: an unknown model id is something a user can report or add a pricing override for, whereas "some tokens are unpriced" is not actionable. `cost_usd` continues to mean "the cost we could price", so the two are reported side by side and never summed.

`GET /v1/status` may carry `desktop` — `{five_hour_pct, seven_day_pct, at, stale}` — the Claude **desktop app's** own plan usage, read on request from `plan-usage-history.json` in the app's support directory. It is omitted entirely when the app is absent, has never run, or wrote something we cannot parse; most people do not use it, so absence is a normal answer rather than an error.

What that file holds bounds what may ever be said about it: a timestamp and two window percentages. **No tokens, no cost, no conversation content**, so this can never state what the desktop app cost — only how much of a window it consumed. It is also written only while the app runs (27 samples in a day on one real machine, against ~290 at its five-minute interval), so a reading older than 20 minutes is flagged `stale` and the UI says the app has been closed since. Nothing is stored and nothing is polled.

`PUT /v1/settings` also accepts `gemini_api_key`, stored write-only in the same way. `GET` reports `gemini_key_set` and `gemini_key_from_env` instead of the value; `GEMINI_API_KEY` in the daemon's environment takes precedence over the stored key when both exist ([ADR-025](08-decisions.md)).

`PUT /v1/settings` accepts `report_bot_token` and `report_chat_id` for the weekly report. The **token is write-only**: it is stored and never returned by `GET /v1/settings`, which instead carries `report_bot_set` (a bool), `report_last_error` and `report_last_sent_ms`. This is the only write-only field in the API and it exists because the settings response is read on every dashboard render and by `caprock report` — a credential should not ride along on either ([ADR-024](08-decisions.md)). Omitting `report_bot_token` from a PUT leaves the stored one alone, since a UI that reads settings and writes them back always omits it; sending `""` clears it. The chat id is not a credential and round-trips normally.

`GET /v1/gemini` reports whether asking Gemini is possible here: `{available, env_var, licensed, model}`. It performs **no network I/O** and **never returns the key** — `available` says only that one is present. `POST /v1/gemini/ask` takes `{prompt, model?}` and answers `{text, model, usage}`, where `usage` carries the response's own `promptTokenCount` / `candidatesTokenCount` / `cachedContentTokenCount` / `thoughtsTokenCount`. It is the one endpoint in the product that checks the licence **server-side** (402 without an active key) rather than leaving the paywall to the UI, because the call spends the user's Gemini quota and opens an outbound connection — the reasoning and its limits are in [ADR-023](08-decisions.md). With no key set it answers 412 with the variable to set, which is a different problem from 402 and is reported separately so the screen can say which. The key is read from `GEMINI_API_KEY` in the daemon's environment at call time; it is never stored, never accepted by `PUT /v1/settings`, and never present in `GET /v1/settings`.

`GET /v1/update` returns `{enabled, current, latest, update_available, command, url, checked_at, error, notes, notes_for}` from cache and **performs no network I/O** — a page load must never cause an outbound call. `POST /v1/update/check` performs one, and returns **403 while `update_checks` is false**: the opt-in is enforced by the server, not merely hidden in the UI, so no page or local script can make Caprock reach the network uninvited. Checks are throttled to once a day unless forced, the request carries no body or credentials, and a failure is reported in `error` rather than as an error status — not knowing about a release must not read as a broken dashboard. `command` is the upgrade command inferred from the running binary's path (Homebrew, Scoop, `go install`); when no package manager owns the binary it is empty and the UI offers `url` instead. `notes` is the published release's own description, taken from the same GitHub response as the tag — reading it costs no second request and no further exposure. It is trimmed to a dialog-sized excerpt (long bodies cut at a line boundary) and paired with `notes_for`, the version it describes, so a cached note can never be shown beside a different version after a failed check. `update_available` is never true for a `dev` or `git describe` build. Caprock does not install the update: replacing the running binary would mean the daemon killing the process executing the command, and running a package manager on the user's behalf from a web page is a surface a local tool should not open.

**`PUT /v1/settings` is a patch, not a replace.** Fields are decoded as pointers, so a body changes only the keys it names and leaves the rest as they were; `PUT {}` is a no-op. An explicit `false` is still honoured, so nothing here is write-only. This is not a convenience: decoding into a plain struct made an absent field indistinguishable from a cleared one, so a short body — or a retry that dropped fields — answered 200 while resetting the stated plan *and* switching the release-check opt-in off. The plan decides what every cost figure on the dashboard claims to be, and `update_checks` gates rule 4's single outbound call; neither may be toggled by omission.

`GET`/`PUT /v1/settings` carry `{plan_kind, plan_label, plan_usd_per_month}` — how the user pays for Claude Code. Caprock **cannot detect this and never guesses**: Claude Code does not report the plan, and inferring one from usage would be an invented number (rule 6), so the user states it and it is stored in `config.json` like every other setting. `plan_kind` is `""` (not stated), `"flat"` (Pro/Max/Team seat — usage at API list price is an *equivalent*, so comparing it to the fee is meaningful), or `"metered"` (API key, Bedrock, Vertex, or Enterprise usage billed at API rates — the API-list figure **is** approximately the bill, so it is never framed as a saving). `PUT` validates rather than coerces: an unknown `plan_kind` or a negative/non-finite price is a 400, because a typo would otherwise drive a wrong headline figure. Both return 501 when the daemon has no settings controller.

`SessionSummary` = the `sessions` row + `stats` (session_stats) + `activity` ({phrase, tool, at, health, plan, repeats} from `internal/narrate`) + `savings` (cache math) + `loop` (active alert, if any) + `context` ({tokens, window, pct} — last turn's prompt size vs the model's context window from `pricing.json`). `SessionDetail` adds `files` and the last 60 `events`. `?range=` on `/v1/stats/summary` accepts `today` (default), `7d`, `30d`, `all`, or a Go duration; ranges are calendar-aware in the daemon's local time zone. The summary carries `burn` ($/h and tokens/min over the last 10 minutes) and `pricing_version`. Each entry in `projects` is `{project, tokens, cost_usd, sessions, paths?}` — one row per **repository** (see § Repository grouping DDL), where `sessions` counts the distinct sessions that touched it in the range, so a per-repo roll-up can state both what a repo cost and how many sessions worked in it. `paths` is the per-directory breakdown: `{path, tokens, cost_usd, turns, unattributed?, outside?, tokens_pct, cost_pct}`, charged by **carry-forward** from the files the repository's turns touched rather than by the directory a session was launched from (see § Touch attribution DDL). Two entries are not directories and must be rendered as their own thing: `unattributed` (turns before their session touched any file) and `outside` (turns whose most recent touch was outside the repository); a bucket row that cost $0 is omitted. `path` is the full directory relative to the repository root, written from it (`/`, `/services/api`). It is **omitted for a repository with fewer than two rows**, which would merely restate the row's own total, and it always sums exactly to the parent row — the panel must never state two different totals for one repository (rule 6). `turns` replaces a session count because a session touches many directories while a turn is charged to exactly one, so turns partition and add up. `tokens_pct` and `cost_pct` are shares of the **repository total including the unattributed row**, so each column sums to 100% and the share nothing could be attributed to is visible as its own number rather than hidden in the denominator; both are sent because cost per token varies by model and the two genuinely differ. Each entry may also carry `spark` — `{from_ms, width_ms, cost[], tokens[]}`, the row's spend over time, where bucket `i` covers `[from_ms + i*width_ms, from_ms + (i+1)*width_ms)`. Cost and tokens are parallel arrays over the **same** buckets, so which one the panel plots stays a display choice rather than a request — changing the basis must never cost a round-trip on a polled endpoint. The panel currently plots tokens (see [04-ui.md](04-ui.md)). The grid follows the range and starts at the same calendar-aligned instant: `today` → 24 hourly buckets, `7d` → 7 daily, `30d` → 30 daily, a typed `<n>d` (n ≤ 90) → n daily. `spark` is **absent for `range=all`**, whose start is the first event ever captured — a fixed bucket count would make a column mean a different span on every machine. The columns sum to at most the row total and never more: spend inside the range but outside the bucket grid still counts toward the row, because dropping it would understate the bill (rule 6). `paths` entries carry no series — a sparkline per directory would multiply a polled payload for a picture hidden until the row is expanded. The summary also carries `work` and `work_unlinked_calls` — what the money was spent **on**, by the kind of work each turn did (see § Work attribution DDL).
### Phase 1 additions

```
POST   /v1/agents                    {cwd?, chat?, create?, worktree?, model?, permission_mode?, command?, args?} → {session_id, cwd}
POST   /v1/agents/{id}/input         {data}            → 204   (owned PTYs only)
POST   /v1/agents/{id}/signal        {action: pause|resume|kill} → 204 (owned PTYs only)
WS     /v1/agents/{id}/term          bidirectional stream (xterm.js): binary = keystrokes, text = control; snapshot on connect, closes on exit
POST   /v1/paste                     {type, data:base64} → {path}; writes a pasted file so Claude Code can read it
GET    /v1/history?range=…           lifetime totals + tool distribution + model mix + daily
```

**Non-Anthropic pricing.** `pricing/pricing.json` carries rows for the models Caprock observes through OpenCode — DeepSeek and MiniMax at the providers' own published rates, fetched with a date and noted in the file. They are priced so a total that includes non-Anthropic usage is a total; before this, $155 of the owner's own spend sat outside his. `normalizeModel` strips a gateway's vendor prefix, so `minimax/minimax-m3` from OpenRouter and `MiniMax-M3` from the direct API are one row rather than two, one of them unpriced. The unpriced warning fires only on turns whose tokens are greater than zero: a turn recorded with explicit zeroes has nothing to price, and warning about it says a total is missing money it is not missing.

### Daily sessions DDL (migration 0020)

```sql
CREATE TABLE IF NOT EXISTS daily_sessions (
  day        TEXT NOT NULL,   -- local date, matching daily_stats.day
  project    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (day, project, session_id)
) WITHOUT ROWID;
```

`daily_stats.sessions` was incremented when a session recorded its **first turn
ever**, so a session begun yesterday added nothing to today and a day whose work
was all continuations read zero sessions beside real spend — four of the last
eight days on the owner's database. The marker answers "first turn of this
session *on this day*" instead.

Two things about the key are load-bearing:

- **Not keyed by model**, though `daily_stats` is. The dashboard sums a day's
  rows, so the count must live in exactly one of them; keyed by model as well, a
  session that switched from Opus to Haiku mid-day counted twice — measured as 3
  against a true 2 on 27 August.
- **The backfill matches on the day alone**, not on `(day, project)`. A
  session's project is resolved from its cwd and can be renamed later — a chat
  started before its repository was known is stored as a timestamp and becomes
  `chat` — so historical `daily_stats` rows and markers rebuilt from events
  disagree about the name while agreeing about the day. Joining on the name left
  those days at zero, which is the bug being fixed. After the migration all ten
  recent days on the owner's database match a `COUNT(DISTINCT session_id)` over
  the events themselves.

### Tool bytes DDL (migration 0018)

```sql
ALTER TABLE events ADD COLUMN tool_bytes INTEGER NOT NULL DEFAULT 0;
```

Filled from the tool response as the event is stored, and backfilled once from
`json_extract(payload,'$.tool_response')` for events already on disk. It is
stored rather than measured per request because the panel that reads it asks
for every event ever recorded, and reading a column out of a 641 MB table's
payloads took 2.1s of a screen that is supposed to answer at a glance.

**Bytes, and deliberately not tokens.** A tool result arrives in the transcript
with no token attribution of its own, so a token figure here could only be a
bytes-per-token conversion — and the linkage that would have to carry it is
uneven: 14% of Bash calls cannot be matched to the turn that paid for them
against 1% of Read's. The converted number would understate Bash specifically,
which is the comparison the tool table exists to make. A figure that looks
measured and is quietly skewed is worse than one that is not there;
[rule 6](../CLAUDE.md) is what makes that the rule rather than a preference.

**Tool distribution DDL.** `idx_events_tool_dist` on `events(kind, ts, tool, tool_bytes)` exists so the ALL TIME panel's tool table is answered from a covering index. Without it SQLite finds rows by (kind, ts) and then fetches each from the table to read two columns — and those rows carry the whole hook payload, which was most of the 2.1s the query took. Covering, it is 0.05s, measured on the owner's 254k-event database (2026-09-02). It replaces `idx_events_kind_ts_tool` from migration 0016, which is the same index without `tool_bytes`; both would cost two copies of the same thing on every insert, so `0019_drop_superseded_tool_index.sql` drops it — as its own migration, because 0018 had already run where it mattered and an edit to an applied migration is an edit nobody receives. `idx_events_kind_ts` is left alone — it serves every other kind+range query and none of them want `tool` along for the ride. Migrations `0018_tool_bytes.sql`, `0019_drop_superseded_tool_index.sql`.

**`caprock license` manages the key from the terminal** — `license` shows it, `license set <key>` stores it (refusing one that will not work rather than leaving someone to wonder why nothing happened), `license clear` removes it, and `license issue --days N | --lifetime` mints one. Issuing exists because the Stripe webhook was the only thing that could make a key, which leaves no way to serve a customer who paid another way, a refund reissued, or a friend. `license.Issue` and the webhook produce the same format and a cross-repository test holds them together. The random suffix is optional: nothing verifies it, it exists so two keys issued on the same day are distinguishable in an email, and a key dictated over the phone has to work without it.

**`GET /v1/premium` also reports the licence state.** The response carries `license` — `{active, in_grace, expires_at, reason}` — decided from `settings.license_key` and the expiry inside it, locally. No signature, no network call: the binary is Apache-2.0 so a check is deletable in five minutes either way, and [rule 4](../CLAUDE.md) is the product's argument rather than a feature of it ([ADR-022](08-decisions.md)). A key is `CR-YYYY-MM-DD-XXXXXXXX`, where the date is the last day covered; features continue for seven days past it so a late renewal does not interrupt work. `PUT /v1/settings` accepts `license_key` and trims it — a key pasted with a newline is the likeliest way the one interaction that turns a payment into a working feature goes wrong.

**`GET /v1/premium` is what the paid plan costs**, so the dashboard can state a price without an outbound call and without a second copy of the figure. It is compiled in — rule 4 forbids fetching it — but it lives once, in `internal/premium`, and `TestPricingMatchesTheSite` reads the site's `src/content/pricing.ts` and fails when the two disagree. A price copied into the UI eventually contradicts the one that charges the card; this makes that a red build rather than a support email. The response carries `yearly` and `monthly` (`per_month_usd`, `charged_usd`, `period`, `url`) plus `info_url`. Changing a price means changing both files in the same commit.

**`chat` starts a session without a working directory**, for asking something rather than working on a repository — Caprock creates one under `<data_dir>/chats/<YYYY-MM-DD-HHMMSS>/` and spawns there. `cwd` is required unless `chat` is set. One directory **per chat**, never a shared `chats/` folder: Claude Code keys a transcript by working directory, so a shared folder would collapse every conversation into one project row and one transcript. The name carries a counter when two chats start inside the same second. Chats live under the data directory rather than a second `~/.caprock` — one place holding Caprock's state is one place to back up, clean out and explain.

**`create` makes the working directory, one level, under a parent that already exists.** Starting a new project otherwise meant leaving the dashboard, creating the folder in a terminal, and returning to type its path — a path the user had already typed. It is opt-in and defaults to false: this endpoint executes a command from its body, so a missing directory stays an error unless the caller explicitly asked for it to be made. Deliberately `Mkdir`, never `MkdirAll` — the parent must exist, so a typo in an absolute path fails loudly instead of materialising a chain of directories somewhere the user has never been. The path is cleaned before the parent is checked, so a path that climbs out with `..` is verified against where it actually lands. An existing directory is not an error.

Owned sessions are spawned as `claude --session-id <uuid> [--model …] [--permission-mode …]`, so hooks and the transcript arrive under the id Caprock generated; the spawn environment strips inherited `CLAUDE_CODE_CHILD_SESSION` / `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` markers so the session is a normal top-level one. Before spawning, Caprock pre-accepts Claude Code's folder-trust dialog for the session's cwd by setting `projects["<cwd>"].hasTrustDialogAccepted = true` in **`~/.claude.json`** (a second user-level Claude Code file, distinct from `settings.json`) — otherwise an interactive session blocks on the trust prompt, which `--dangerously-skip-permissions` does not suppress. The write is best-effort, atomic, and skipped if the folder is already trusted; an unparsable `~/.claude.json` is never modified. It goes through the **ordered-JSON codec**, preserving the user's key order and any integer beyond 2^53 — a `map[string]any` round-trip sorted the whole 200KB file alphabetically and truncated large integers through float64. Each grant Caprock makes is recorded in `<data_dir>/trust-grants.json`, so `caprock hooks uninstall` revokes exactly the folders Caprock trusted and never one the user accepted themselves; a folder already trusted when Caprock found it is never claimed. Spawning is unavailable (endpoints return 501, `status.claude_available=false`) when no `claude` binary is found; Caprock then stays observe-only. The manager resolves `claude` via PATH then `~/.local/bin`, `~/.claude/local`, `~/bin`, Homebrew and `/usr/local/bin`. Control operations are refused for sessions Caprock did not spawn.

### Phase 2 additions

```
POST     /v1/hive                     {hive?, repo?} → {hive, repo}   turns the task runner on, no restart
GET/POST /v1/tasks
GET      /v1/tasks/{id}
POST     /v1/tasks/{id}/approve | /v1/tasks/{id}/reject
POST     /v1/tasks/{id}/verify        → runs the task's done_criteria, returns VerifyResult
GET      /v1/approvals
POST     /v1/orchestrator/start       → spawns the orchestrator session → {session_id}
POST     /v1/orchestrator/stop        → kills the orchestrator + every worker → {stopped: n}
```

**`GET /v1/tasks/{id}` also answers "where is the work, and what proved it".** Alongside `{task, body}` it returns `done_criteria` (read back off the hive file — the SQLite mirror drops it, so nothing the API returned could say what "done" would mean for a task) and a `work` block: `branch`, `worktree`, `repo`, `sessions[]` (`session_id`, `cwd`, `from_ts`, `to_ts`) and `verifications[]` (`round`, `command`, `exit_code`, `output_path`, `ts`). Everything in `work` is derived per request, never stored — `branch` and `worktree` are the same strings `git worktree add -B caprock/<worker> <repo>/.caprock-worktrees/<worker>` was given, and the rest is read from `task_assignments` and `verifications`. It exists because `GET /v1/sessions/{id}/diff` is keyed on a *session* id while the board knew only the hive *agent* id, so no task card could link to the diff of its own work. Assembled in the daemon's `boardAdapter`, which is the only layer that knows the repo.

**`POST /v1/hive` turns the task runner on over a running daemon.** It opens (creating and seeding) the queue directory, starts the board, wires the orchestrator, and returns the `{hive, repo}` in force — no restart. Both fields are optional; an empty body means the daemon's own suggestion, which is exactly what `GET /v1/status` offers. Everything the board needs (store, bus, session manager, logger) is already running, so the only thing that ever required a restart was that `--hive` was read once at startup: the board is now resolved per request, and the Stop hook's `Decide` is wired unconditionally so the Stop-loop starts working the moment the runner is on. Turning it on a second time is `409` rather than a silent rebuild — a second board over a different directory would leave the first one's router running against task files nobody is looking at. It exists because the dashboard's off state could otherwise only hand the user a command to paste into a terminal, which is not a control. It arms nothing by itself: spawning is still the separate, explicit `POST /v1/orchestrator/start`.

**`GET /v1/status` reports the hive.** `hive` and `repo` carry the queue directory in force and the checkout its workers operate on; both are omitted when orchestration is off. Which hive a running daemon had been started with was previously reported nowhere — not in `/v1/status`, not in `caprock status`, not in the startup line or the log — so there was no way to ask a live daemon what it was orchestrating. While it is **off**, `suggested_hive` (`~/caprock-tasks`) and `suggested_repo` (the daemon's cwd) carry what `POST /v1/hive` would use with no body — the defaults the dashboard names in its confirmation before turning anything on. Both are suggestions, not state: nothing is created until the POST.

**`POST /v1/tasks` validates before it writes.** A title is required (trimmed, at most 500 characters), the body is capped at 100 KB, and `budget_usd` must be finite, non-negative, and at most 100,000. Each of these was accepted before and produced a task nobody could use: an unnamed row on the board, a hundred-thousand-character title rendered into the task file, a negative budget that breaks every "is there budget left" comparison, and `1e308`, which overflows the moment anything is added to it.

**`done_criteria` is required.** At least one non-blank command; blank entries are trimmed away first. An empty list used to pass verification unconditionally ("trust the worker"), which made the product's central claim — nothing reaches `done` until its `done_criteria` pass — false for the easiest task to create. A task that nevertheless reaches verification with no criteria (hand-written into the hive, or created before this rule) escalates to `needs_you`; it never passes. See [05-orchestration.md § Verification runner](05-orchestration.md).

**`budget_usd` is enforced, not decorative, and never defaults to unlimited.** The reconciler tick re-attributes each live task's cost and, when spend passes the budget, **kills the worker session** before moving the task to `needs_you`, with the reason appended to the task body (no column, no DDL — the body is already returned by `GET /v1/tasks/{id}` and rendered by the UI). Parking the file alone left the process spending. `0` or absent on create becomes `board.DefaultBudgetUSD` ($5): an unattended session with no ceiling was the unsafe default. `budget_usd: 0` in a hand-authored hive task file still means no limit — Caprock does not rewrite a user's file. See [05-orchestration.md § Approvals](05-orchestration.md).

**`POST /v1/orchestrator/stop` is the emergency stop.** One call kills the orchestrator and every worker it spawned, and latches the router so it does not respawn them on the next tick; `start` clears the latch. It stops processes and leaves task files untouched. `POST /v1/agents/{id}/signal` remains the per-agent control — it takes `{"action": "pause"|"resume"|"kill"}`, and its 400 names that field, not only the accepted values.

**`POST /v1/tasks/{id}/verify` never strands a task.** Verification walks a legal status route rather than skipping a transition it cannot make in one hop, so a verify from any non-`verifying` status still lands the task in `done`, `in_progress` or `needs_you`. Guarding a single hop and no-opping when illegal used to leave the task where it was, after which the next verify failed with `illegal task transition`.

**Task ids carry a per-process sequence** (`t-<unix-ms>-<n>`). The millisecond alone collided: twelve concurrent creates produced four tasks and eight "already exists" rejections, so a user adding several at once silently lost most of them.

Live frames gained `mail.*` events (router) in Phase 2.


**`GET /v1/stats/summary` takes `?agent=`** — `claude`, `opencode`, or omitted
for both. An unrecognised value is a **400**: returning every agent's spend
under a heading that names one is worse than an error, because nothing on the
screen would say so. The filter is a subquery on `sessions` rather than a join,
because `events` carries no agent of its own and a join would change the row
multiplicity of five separate aggregates — a silent way to double a cost.


## SQLite schema (DDL v1)

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,          -- rowid, monotonic
  ts          INTEGER NOT NULL,             -- unix ms
  session_id  TEXT NOT NULL,
  source      TEXT NOT NULL,                -- 'hook' | 'transcript' | 'opencode' | 'gemini'
  kind        TEXT NOT NULL,                -- see 02-architecture.md § Event model
  tool        TEXT,
  payload     TEXT NOT NULL,                -- raw JSON
  tokens_in   INTEGER, tokens_out INTEGER,
  cache_read  INTEGER, cache_write INTEGER,
  cost_usd    REAL,
  msg_id      TEXT,                          -- assistant message id (migration 0012)
  touch_dir   TEXT,                          -- directory the tool touched (migration 0012)
  tool_bytes  INTEGER NOT NULL DEFAULT 0     -- bytes the tool returned (migration 0018)
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT, project TEXT, model TEXT,
  started_at   INTEGER, last_event_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'active',  -- active|idle|ended
  transcript_path TEXT,
  agent        TEXT NOT NULL DEFAULT 'claude',  -- claude|opencode|gemini (0015)
  pid          INTEGER NOT NULL DEFAULT 0       -- the session's process, 0 = unknown
);

**A session ends when its process does.** `pid` is what makes that answerable:
Caprock records it for every session it spawns, and for a session started in a
terminal the shim sends its parent — the Claude Code that ran it — as the
`X-Caprock-Ppid` header on `POST /v1/hook`. A header rather than a body field,
because the body is Claude Code's payload forwarded verbatim.

An upsert only ever raises a pid: an event carrying `0` means *this event did
not know*, which must not erase one an earlier event did know.

The sweep asks whether that process is alive rather than how long the session
has been quiet. A session with a live process may sit silent for a week and
stay open. Three silence thresholds were tried before this and all were wrong
for somebody — twelve hours left the day's work live at midnight, one hour
closed a session while its owner was at lunch. See
[ADR-028](08-decisions.md#adr-028--a-session-ends-when-its-process-does).

Two exceptions, both deliberate:

- **Agents Caprock only observes** (`opencode`) are judged by the clock alone.
  Their rows are read out of another tool's database, arrive months old, and
  have no process of ours to ask about.
- **Sessions with no pid** — written by an older shim, or read from a transcript
  with no live process behind them — fall back to a 24-hour staleness sweep,
  because there is nothing to verify and the only cost of being slow is a stale
  row.

**`sessions.status` is derived, and `ended` is sticky only against the past.**
An explicit status from a caller (a `SessionEnd` hook, `SetExit`, the sweep)
always wins. Otherwise an upsert marks the session `active` unless it is
already `ended` *and* the incoming event is no newer than the one stored — so
re-reading a finished session's transcript cannot resurrect it, while a session
that is still emitting events is alive by definition.

The timestamp test is the whole rule: without it, `ended` was permanent, and
since stopping the daemon ends every live session, a restart left a working
agent marked ended until it happened to start a new session — the pulse showed
nothing while the agent was visibly working.

CREATE TABLE session_stats (       -- rollup, updated on write
  session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
  turns INTEGER, tool_calls INTEGER, files_touched INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_usd REAL
);

CREATE TABLE daily_stats (
  day TEXT, project TEXT, model TEXT,
  tokens_total INTEGER, cost_usd REAL, sessions INTEGER,
  PRIMARY KEY (day, project, model)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- schema_version, pricing_version
```

**Migrations:** embedded, sequential, `meta.schema_version` gated.

### DDL v2 (added in T2, `0002_event_keys.sql`)

Additive only; DDL v1 stays verbatim in `0001_init.sql`.

- `events` + `key TEXT` (dedupe handle, see § Hook shim), `model TEXT`, `cache_write_1h INTEGER`, `agent_id TEXT`; `UNIQUE INDEX (session_id, key) WHERE key IS NOT NULL`.
- `sessions` + `has_hooks`, `has_transcript` (which planes have been seen), `git_branch`, `version` (Claude Code version).
- `session_files (session_id, path, first_ts, last_ts)` — files touched, so `files_touched` is a real count.
- `transcript_offsets (path, session_id, offset, updated_at)` — resume tailing after restart.
- `meta.transcript_schema_version` — parser schema version in force.

### Phase 1 DDL additions

```sql
ALTER TABLE sessions ADD COLUMN owned INTEGER NOT NULL DEFAULT 0;  -- spawned by Caprock
ALTER TABLE sessions ADD COLUMN worktree TEXT;
CREATE TABLE throttle_observations (ts INTEGER, session_id TEXT, kind TEXT, payload TEXT);
```

`throttle_observations` records each `StopFailure` (rate_limit / overloaded / billing) — a post-hoc "a limit was hit" fact; the Cost screen shows the count per range.

### Repository grouping DDL (migration 0011)

```sql
ALTER TABLE sessions ADD COLUMN repo_root TEXT;   -- absolute repository root, '' outside a repo
ALTER TABLE sessions ADD COLUMN repo_path TEXT;   -- location within the repo, '' at its root
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(session_id, project, repo_path);
```

`sessions.project` is the **repository** a session's cwd belongs to, not the cwd's basename. The basename made one repository several rows (`caprock` and `ui`), let a subdirectory pose as a project (`app` under the monorepo), turned Caprock's own agent worktrees into projects (`worker-1`), and — the silent failure — summed two unrelated paths that happened to end in the same segment into one row.

- **Resolution** — an upward walk for `.git`, done once per distinct cwd behind an in-process cache, at ingest only. A `.git` **file** is a linked worktree: its `gitdir:` pointer is followed to the owning repository, so a worker's spend lands on the repository it is working on. A `gitdir:` under `.git/modules/` is a submodule and stays its own repository.
- **Stored, not derived on read** — historical sessions point at directories that may no longer exist, so a read-time walk would relabel yesterday's spend according to what is still on disk today; and `/v1/stats/summary` is polled, so a filesystem walk per row is a syscall storm on a hot path.
- **Backfill** — `Store.backfillRepo` runs immediately after the migration (resolution needs the filesystem, which SQL cannot reach), is idempotent, and only writes rows whose `repo_root` is still NULL. A failure is logged and leaves the old labels in place rather than refusing to open the database.

### Touch attribution DDL (migration 0012)

```sql
ALTER TABLE events ADD COLUMN msg_id TEXT;      -- assistant message id; links a tool call to the turn that paid
ALTER TABLE events ADD COLUMN touch_dir TEXT;   -- directory the tool touched, slash-normalized; NULL when none
CREATE INDEX IF NOT EXISTS idx_events_touch ON events(kind, ts, session_id, msg_id, touch_dir);
CREATE INDEX IF NOT EXISTS idx_events_msg ON events(session_id, msg_id) WHERE msg_id IS NOT NULL;

-- migration 0013, widened by 0014: the carry-forward scan's order, covering
-- every column it reads — including `tool`, which the work-kind breakdown
-- classifies each turn from. SQLite cannot add a column to an index in place,
-- so 0014 creates the wider index and drops the narrower one.
CREATE INDEX IF NOT EXISTS idx_events_attr_work ON events(
  session_id, ts, id, kind, msg_id, touch_dir, tool,
  cost_usd, tokens_in, tokens_out, cache_read, cache_write
);
DROP INDEX IF EXISTS idx_events_attr;
```

The per-directory breakdown is charged by **which files Claude touched**, not by the session's cwd. In a monorepo nobody launches Claude from `/services/api` to work on it, so cwd answers "where was the terminal"; on the owner's database only one repository expanded at all.

- **The linkage is `msg_id`, and it is exact.** A `tool_use` block and the usage billed for it are content blocks of the **same** assistant message, so they share its id by construction. It is written at ingest because nothing downstream can recover it: one API response is written as several assistant lines (thinking / text / tool_use) that each repeat the same usage, the store keeps only the first (key `msg:<id>`), and the tool_use blocks arrive on a later line whose turn row was deduped away — which puts the tool rows *after* the next distinct turn. Measured against transcript ground truth (2026-08-22), nearest-preceding-turn recovers the true message id for **1981 of 5115** tool calls (38.7%): a systematic one-turn shift, not noise.
- **Carry-forward attribution (migration 0013).** A turn belongs to the directory of the **most recent file touch at or before it, within the same session**, and the attribution carries forward until a touch in a different directory moves it. Work happens in stretches — after "finish /app" Claude edits, runs the tests, reads the output, greps, edits again — and that whole stretch is work on `/app`. No cost is split, pro-rated, or modelled: each turn's price goes **whole** to one row and the rows still sum exactly to the repository total (rule 6). What the rule decides is *which* row, and it is stated to the user wherever the breakdown is shown (`store.TouchRule`). It is **not** measured file-by-file attribution and must never be described as such.
- **Why the previous rule was replaced.** Strict attribution charged a directory only when **every** file a turn touched was in it, and everything else — including every turn that touched no file — became "repository-wide work". On the owner's database that bucket was **87.6%** of the monorepo's spend: the user asked what a service cost and seven eighths of the answer was "we could not tell". Carry-forward gives the same repository `/app` 61.0% ($2090.67), `/.ai` 6.8%, `/app/tests` 2.8% (measured 2026-08-22, all time).
- **The touch rule.** A tool that names a **file** touches that file's directory: `Read`, `Edit`, `Write`, `NotebookEdit`. `Bash` does not, even when its command contains a path — `grep -r foo /services` reads a tree and `cd /services/api && go build ./...` names one directory while touching many, so parsing intent out of a command line would be inference presented as measurement. Under carry-forward that costs nothing: a `Bash` turn is placed by the file touched before it rather than dropped, which is why the largest tool by volume no longer drains the breakdown.
- **Outside the repository is its OWN row**, not a directory and not the repository-wide bucket. On the owner's database it is **25.8%** of the monorepo and **28.7%** of `caprock` — not other people's work but work on *this* project whose files live elsewhere: Claude's notes under `~/.claude/projects/<project>/memory`, agent scratchpads under the per-session temp directory, test-output directories, occasionally another checkout. Folding it into the repository root would claim work happened in the checkout that did not; dropping it would stop the parts reconciling. It deliberately does **not** distinguish "another checkout" from "scratch space": the only available test is whether the path sits under some other repository root the database happens to know, which is unstable — `caprock-web` is a real repository on disk that no session was launched from, so the same path would classify one way today and another tomorrow.
- **Turns before any touch** land in the repository-wide row rather than carrying **backward** from the session's first touch. Measured both ways (2026-08-22, all time): carrying backward moves $2.39 of $3426 in the monorepo and $11.45 of $1729 in `caprock` — 0.1% and 0.7%, too little to justify a second rule pointing the opposite way. The row is usually empty, and a bucket row that cost $0 is **omitted** rather than rendered.
- **The carry never crosses a session.** Attributing one session's work to the directory another left behind would charge one piece of work to another's location.
- **Columns, not `json_extract` on read.** `/v1/stats/summary` is polled. Measured through the Go driver on the owner's 191k-event database (2026-08-22, 30d): the summary answers in **~152 ms** warm, while `json_extract` over the 48212 `tool.pre` rows in that range costs **~215 ms** on its own. Resolved at ingest the same scan is **~9 ms**.
- **One ordered scan, pinned with `INDEXED BY`.** Carry-forward is sequential, so the tool calls and the turns are read **together** in event order and the carry is threaded through them in Go — replacing the two independent queries the strict rule used. A window function was rejected: deciding whether the carried directory is inside the repository needs the same path normalization the ingest path uses, and re-implementing it in SQL would put a second, silently diverging definition in a second language (the trap this migration already documents for the dirname cut). Ordering by `(session_id, ts, id)` over `idx_events_kind_ts` sorts 90271 rows in a temp B-tree (**~290 ms**); `idx_events_attr` puts the order in the index and covers every column read, giving a covering scan with no sort at **~93 ms**. Nothing in the daemon runs `ANALYZE`, so without `INDEXED BY` SQLite prefers the `kind` index and reintroduces the sort. **Summary end-to-end: ~250 ms before, ~243 ms after** (2026-08-22, 30d, Go driver) — carry-forward is not slower despite attributing far more of the spend.
- **Backfill** — `touch_dir` is filled by `Store.backfillTouch` (Go, not SQL: the dirname must be cut with the same normalization the ingest path uses, and SQLite has no `reverse`), gated by the `touch_backfilled` meta key because a pathless tool call keeps `touch_dir` NULL forever. `msg_id` on historical `tool.pre` rows is **not** in the database at all — the payload never carried it — so `ingest.BackfillToolMessageIDs` reads it back from the transcripts still on disk. Rows whose transcript is gone stay unlinked and report as unattributed: degraded, never wrong. It covers **every** unlinked tool call, including the pathless majority (Bash and friends): the same `msg_id` carries the work-kind breakdown, where excluding them reported most spend as "no tool call" (OQ-10, resolved 2026-08-23). Because that widening turned a ~3 s pass into a ~30 s one, it no longer blocks startup — the daemon serves first and `Daemon.backfillToolLinks` runs behind it, in id batches, committing a resume cursor (`tool_link_cursor`) after each so a kill costs one batch rather than the whole scan; the sentinel `done` retires it. The older `tool_link_backfilled` key is **not** read as completion: it marks the path-only pass, and a database carrying it still has every pathless call unlinked. Re-running is safe and cannot change an existing link — a `tool_use` id belongs to exactly one assistant message (verified across all 1560 transcripts and 69552 distinct ids on the owner's machine, 2026-08-23), so a retry either finds the same answer or none.
- **No repository** — `/tmp`, scratchpads, and deleted directories keep `repo_root = ''`. No repository name is invented; the label is the directory's own name, and the roll-up keys such rows on their **cwd** so two `scratch` directories stay two rows.
- **Labels vs identity** — rows are grouped by `repo_root` (unique by construction), never by the label. Labels that collide within one response are widened with parent segments (`livegraph/repo`, `orch-live/repo`) until they differ; a unique label is left exactly as the user would say it.

### Work attribution DDL (migration 0014)

`/v1/stats/summary` carries `work` — what the money was spent **on**, as one row per kind of work: `{kind, turns, tokens, cost_usd, tokens_pct, cost_pct}`. It is the third cut of the question the model mix and the project list already answer, and it shares their guarantee: a turn's cost goes **whole** to one row, never split, so the rows sum exactly to the range total.

- **The kinds are a closed set**, keyed by a stable id the UI maps to a label: `edit`, `command`, `read`, `web`, `mcp`, `other`, `none`. A tool Caprock has never seen falls into `other` rather than being dropped, so a new first-party tool is visible instead of silently leaving the total short.
- **`none` is named for what is observable.** A turn that called no tool may have been reasoning, planning, answering a question or writing prose; the capture records which tools ran, not what a turn was doing. It is therefore labelled "no tool call" and never "conversation", "thinking" or "planning" — a flattering label is an invented number in words (rule 6).
- **Reading and searching are one row.** `Read`, `Grep` and `Glob` are the same activity with the same cost driver — the contents enter the prompt and are billed — so splitting them would invite a comparison between two numbers that mean the same thing. Web research and MCP tools *are* separate rows: both are distinct, recognisable activities whose cost a user can act on, and MCP tools are the user's own integrations, which is exactly the cost they are most able to change.
- **Precedence decides a turn that used several kinds** (`store.WorkKindRule`): writing a file beats running a command, which beats reading or searching, then web, then MCP, then anything else. The order is by what the turn most concretely **did**, strongest evidence first — never by cost, which would let the ranking rewrite itself as the data changed. On the owner's database only 2503 of 57521 tool-using turns (4.4%) mix kinds and they carry 2.2% of spend (measured 2026-08-23, all time), so precedence moves very little money — but it is stated wherever the breakdown is shown, because a reader cannot check a rule they cannot see.
- **Work kind does NOT carry forward**, unlike per-directory attribution. A directory carries because work happens in stretches; a work kind is a property of the turn itself. A turn that ran the test suite did command work whether or not the turn before it edited a file, and carrying "edit" onto it would report editing that did not happen.
- **`work_unlinked_calls` travels with the breakdown.** A tool call whose `msg_id` is NULL cannot be attached to any turn, so that turn reports as having called nothing — indistinguishable from a turn that genuinely did. The count of such calls is published so a degraded database says so instead of quietly producing a finding. The dashboard warns above 1% of the range's tool calls; `caprock report` **withholds the breakdown entirely** above 5% and prints the reason, because that output is written to be pasted in public and a wrong ranking becomes someone else's headline.
- **No query of its own.** The rows the breakdown needs are exactly the rows the carry-forward scan already reads, so the classification rides along in that scan. Measured through the Go driver on the owner's 191k-event database (2026-08-23, 30d, best of fifteen): the summary answers in **249 ms** before and **279 ms** after (+30 ms). A separate aggregate over the same events cost **292 ms** on its own — nearly ten times as much for the same seven numbers.
- **Why `tool` had to enter the index.** The scan reads it per row, and it was carried by no existing index, so the plan fell off the covering path onto the table: **~578 ms** against **~80 ms** covering. Migration 0014 widens `idx_events_attr` into `idx_events_attr_work` and drops the original; SQLite cannot add a column to an index in place, and a stale duplicate would cost write throughput on every ingested event for nothing.

### Rate-limit snapshots DDL (migration 0005)

```sql
CREATE TABLE rate_limit_latest  (window TEXT PRIMARY KEY, ts INTEGER, session_id TEXT, used_percentage REAL, resets_at INTEGER);
CREATE TABLE rate_limit_history (ts INTEGER, window TEXT, used_percentage REAL, resets_at INTEGER);
```

`rate_limit_latest` holds the current state per window (upserted); `rate_limit_history` is a throttled sample (≥30s apart) used to compute an honest "at current pace" forecast. Fed by the statusline (below).

## Statusline

`caprock statusline` is registered as Claude Code's `statusLine.command`. Registration is offered by `caprock up` (same consent contract as hooks — TTY prompt or `--yes`) and can be done or reverted explicitly with `caprock statusline install` / `caprock statusline uninstall`; it writes the single `statusLine` key in `~/.claude/settings.json` (backed up once) and never clobbers a statusLine the user set to something else. Claude Code pipes its status JSON on stdin (per assistant message, 300ms debounce); the command prints a compact one-line status to stdout (`model · ctx% · $cost · 5h N% resets HH:MM · 7d N%`) and, best-effort, forwards the `rate_limits` windows (`used_percentage` 0–100, `resets_at` unix seconds) to the daemon via `POST /v1/statusline`. Like the shim it is fire-and-forget and can never break the session: it prints from the stdin JSON **first**, then POSTs with a ≤300ms budget, drops silently if the daemon is down, and always exits 0. `rate_limits` is present only for Pro/Max subscribers (absent → the line still renders, no POST). The daemon's `/v1/stats/summary` returns `rate_limits` (current window state) with a `forecast` string only when the measured usage slope is rising and would reach the limit before the window resets — otherwise the fact alone, never a guess.

### Phase 2 DDL additions

Tables `tasks` (mirror of file state for querying) and `verifications` (`task_id`, `round`, `command`, `exit_code`, `output_path`). Files are the source of truth for hive state; SQLite mirrors them for the UI (rebuildable by rescan). Forced-continue counter for the Stop-loop lives in SQLite per (session, task).

No DDL change was needed for either fix here, only honest use of the existing columns. `verifications.output_path` now holds a real path — `<hive>/verifications/<task-id>/round-<n>-cmd-<i>.log` — instead of the empty string it was always written with, so a green task carries auditable evidence. The forced-continue counter's `task_id` takes the reserved value `/no-task` for a session that owns none (the orchestrator), which is what makes the guard bound it too; a hive id may not contain `/`, so it cannot collide with a real task id.

## Pricing table

- Embedded JSON `pricing/pricing.json` (the spec's "ported from Caprock-python" — authored from the Anthropic pricing page in practice, [ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson)); overridable by a user file (`<data_dir>/pricing.json`); `pricing_version` recorded in `meta` so historical cost is never silently recomputed.
- **The daily spend cap (`settings.cap_usd_per_day`) pauses sessions Caprock started, and only those.** Zero is off and is the default — a threshold nobody chose would eventually stop work for a reason its owner could not explain. The check runs after a turn is **priced**, not on a timer: the day's total only moves when a turn is priced, so a poll would either lag the crossing or ask the database for a sum it already knows is unchanged. Four rules, each with a test that was verified by breaking it: **only owned sessions** — `agents.PauseOwned` refuses any id the manager did not spawn, so [rule 7](../CLAUDE.md) is enforced at the thing holding the process handles rather than by whoever is calling; **paused, not killed** — SIGSTOP, so the conversation, directory and context survive a resume; **once a day** — a session resumed by hand must not be re-paused seconds later, and the day is claimed under a mutex *before* any signal so concurrent turns cannot both fire; **fails open** — an unreadable spend does not pause, because a missed pause costs money while a spurious one stops work that was fine, and the second is the one nobody forgives. `cap_usd_per_day` carries **no `omitempty`**: zero means "off", and omitting it makes an off cap indistinguishable from a daemon too old to have the field — the panel could then be switched on but never off. A negative or non-finite value is a 400 rather than a clamp, like every other validated field here. The suggested limit is **twice the median day, rounded** (`cap.Suggest`, mirrored in the UI): the median rather than the mean because one runaway day would drag an average up and produce a ceiling that never fires — precisely the day the feature exists for — and twice it because a cap set *at* the median fires half the time by definition. It is offered as a click, never prefilled: a number that appears in the field on its own is a number nobody chose, and this one stops work.
- **`GET /v1/browse` lists directories for the folder picker, and is the one endpoint that reads the filesystem on a web page's behalf.** Starting a session required typing an absolute path from memory into a dashboard already showing the reader's repositories. Four rules make this a picker rather than a filesystem-read API: **only directories and only names** (no contents, no sizes); **rooted at `settings.browse_root`** (default `$HOME`), with **symlinks resolved before the containment check** so a link inside the root pointing out of it cannot smuggle a caller past the boundary; **dotfile directories are never listed** — `.ssh` and `.aws` are precisely what a prober wants, while `.git` is reported as a *property* of its parent (`repo: true`) rather than somewhere to descend into; and **"outside the root" and "does not exist" return the identical 404**, so the endpoint cannot be used as an existence oracle for paths the caller may not see. Listings are capped at 500 entries with `X-Caprock-Truncated` set rather than silently cut. Repositories sort first because a repository is what is being looked for. `GET /v1/recent-dirs` is the other half and touches no filesystem beyond an existence check: it lists directories from the `sessions` table, newest first, grouped by repository root where one is known, and omits any that no longer exist — a picker offering a dead path spawns a session that fails.
- **The weekly report states what changed, not what happened.** It is sold on the promise of the repository that cost 3× its usual week and of last week against the one before it, per repository and model — so it must ship as a comparison against the preceding period, not as a digest of the current one. This is not a presentation choice: five readers were shown a digest-shaped description of it and every one of them concluded they would be paying for delivery of figures the free dashboard already shows (FB-027). A digest is a notification; what moved is the thing a week of data can say and a live screen cannot.
- **`/v1/history` is cached for 3 seconds, with single-flight.** The endpoint answers "everything, ever" — four aggregates over the whole events table, ~540ms warm on a 600 MB database — and **five components on the main screen request it on their own timers** (the lifetime strip, the breakdown panel, the share card, the share nudge, and the screen itself). One open tab therefore produced bursts of identical requests, each computed from scratch: 0.61s each, three at a time. Requests for the same resolved range that arrive while one is in flight now wait for it and share its result, and a settled result is reused for `historyTTL`. Measured on the owner's database: **0.61s → 0.001s** for every request after the first. The cache is keyed by the *resolved* range label, so `?range=` and `?range=today` share one entry. **Errors are never cached** — a transient failure held for the TTL turns one bad moment into seconds of a broken screen. The computation runs on a context detached from its first caller: browsers abandon requests routinely, and a caller hanging up must not take the answer away from the callers waiting behind it. Writes do not invalidate: an entry expires within seconds on its own, and the live pulse does not come through this endpoint.
- **Dated prices (migration-free, `pricing.json`).** A model may have more than one row. A superseded price keeps its own row carrying `until` — the last date it applied, inclusive, UTC — and the current price is the row with no `until`; rows for one id are ordered oldest-first. A turn is priced by `LookupAt`/`PriceAt` at **its own timestamp**, so a rate that has since lapsed still prices the turns that ran under it. Without this, the only way to record a price change is to overwrite the figure, which silently restates history at a price nobody was charged — an invented number (rule 6) about our own past. Sonnet 5 is the first case: introductory $2/$10 through 2026-08-30, $3/$15 from 2026-08-31. A row whose `until` will not parse is treated as not applying, so an unparseable date falls through to the current price rather than pricing a turn at an expired one. Exactly one row per model id may omit `until`, and a test enforces it.
- Cost per assistant turn = `tokens_in × input + cache_write × cache_write_price + cache_read × cache_read_price + tokens_out × output`, all prices per token (table values are per MTok ÷ 1e6).
- Cache-savings math (ported from Caprock-python `_savings.py`): `billed_with = in + 1.25·cache_write + 0.10·cache_read` in input-token equivalents; `billed_without = in + cache_write + cache_read`; `saved = billed_without − billed_with`; hit-rate reported as `cache_read / (in + cache_read + cache_write)`. Where the transcript reports the 1h-TTL split (`cache_creation.ephemeral_1h_input_tokens`), those tokens are priced at the 1h write price (2×), not 1.25×.
- **Source of the numbers:** Anthropic first-party pricing page (`platform.claude.com/docs/en/about-claude/pricing`), fetched 2026-08-18. Bedrock/Vertex have separate partner pricing — first-party only across v0.1–v0.3; recorded as [OQ-02](12-risks.md#open-questions).
- The parity target and its fixture story: [OQ-01](12-risks.md#open-questions).

## Autostart service files

`caprock service install` registers the daemon with the OS's own login supervisor. One user-level mechanism per platform; nothing is written outside the user's home, and never into `~/.claude/`.

- **macOS** — a launchd agent at `~/Library/LaunchAgents/dev.caprock.daemon.plist`, loaded with `launchctl bootstrap gui/<uid>`. `RunAtLoad` starts it at login; `KeepAlive` with `SuccessfulExit=false` restarts a crash but leaves a deliberate `caprock down` alone. No `ProcessType` is declared, deliberately: the daemon watches files, so `Background` with `LowPriorityIO` looks correct and was measured to make the dashboard answer in 1.2s what the same binary answered in 185ms from a terminal; `Adaptive` changed nothing, leaving the process at scheduler priority 4 against a normal 20. Any `ProcessType` puts the job in a managed band, so the key is omitted.
- **Linux** — a systemd **user** unit at `~/.config/systemd/user/caprock.service` (honouring `XDG_CONFIG_HOME`), enabled with `systemctl --user enable --now`, `Restart=on-failure`. Without a systemd user session the install fails with an actionable message and writes nothing.
- **Windows** — a `.cmd` script in the Startup folder. A Scheduled Task cannot be rendered into a temp directory for a test, so verifying one means leaving a real logon task in the runner's store; the Startup script is an ordinary user-owned file, so its generation is unit-tested on every OS. The cost is that Windows restarts the daemon at logon but not mid-session.

The service runs the daemon with `--foreground` (the supervisor owns the process lifetime, so the daemon must not detach), `--no-open`, and `--no-hooks` — hook and statusline registration stay an interactive consent decision, never something a login agent performs.

## Runtime file

`<data_dir>/runtime.json` = `{"port": 4173, "token": "<random per run>", "pid": <daemon pid>, "started_at": <unix ms>}`; written 0600 by `caprock up`, deleted by `caprock down`; the shim reads it on every invocation. What `<data_dir>` resolves to per OS is owned by [ADR-013](08-decisions.md#adr-013--data-dir-and-config-conventions).

### File permissions

Everything Caprock writes into `<data_dir>` is owner-only on POSIX. The data directory is `0700`; `config.json`, `runtime.json` and the log are `0600`; and **`caprock.db` plus its `-wal`/`-shm` siblings are `0600`**.

The database is included because it stores prompts and responses in cleartext — that is what makes the Answers screen searchable — so a world-readable mode hands every other local account the user's entire session history. It was previously left at whatever the process umask produced, which under a default umask is `0644`, while `config.json` beside it had always been `0600`.

The mode is applied by `store.secureDBFiles` on **every** `store.Open`, not only at creation: a database written by an earlier version keeps its `0644` until something changes it, and SQLite recreates `-wal`/`-shm` on demand under the umask, so a creation-time fix alone would regress on the next open. A filesystem that refuses `chmod` (a network share, a container volume) produces a logged warning and a running daemon rather than a failed start — a permissions limitation must not become an outage.

**Windows is a deliberate no-op**: NTFS has no POSIX mode bits, `os.Chmod` there only toggles the read-only attribute, and applying `0600` would risk a read-only database while achieving nothing. Access is governed by the ACL inherited from the per-user data directory. The permission tests skip on Windows with that reason (rule 2).

## Transcript JSONL (observed shape)

Not a public contract — the parser is schema-versioned and degrades to hooks-only mode on unknown shapes ([12-risks.md RISK-02](12-risks.md#risks)). What `ingest` relies on, as observed in a real Claude Code 2.1.x transcript on 2026-08-18:

- One JSON object per line; `type` ∈ `user`, `assistant`, `system`, `attachment`, plus session-meta lines (`mode`, `permission-mode`, `ai-title`, `last-prompt`, `file-history-snapshot`, `bridge-session`) which are ignored.
- `user`/`assistant`/`system` lines carry `uuid`, `parentUuid`, `timestamp` (RFC 3339), `sessionId`, `cwd`, `version`, `gitBranch`, `isSidechain`.
- `assistant` lines: `message.model`, `message.id`, `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`; `message.content[]` blocks (`text`, `tool_use`, …).
- `system` lines with `subtype: "turn_duration"` carry `durationMs`.
- The transcript is written asynchronously and may lag the in-memory conversation (Claude Code documents this) — hence hooks are the real-time source and transcripts the accounting source.
- Files live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; `transcript_path` in hook payloads points at the exact file. Subagent transcripts live at `<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl` and carry the parent `sessionId` plus `agentId`, `isSidechain: true`.
- **One API response is written as several `assistant` lines** (thinking / text / tool_use blocks split across lines), each repeating the *same* `message.id`, `requestId` and `usage`. Verified 2026-08-18 across 16,210 such groups in local transcripts: usage never differs within a `message.id`. Ingest therefore counts usage once per `message.id` (dedupe key `msg:<id>`); summing per line would over-count cache tokens 2–3×.
- Lines with `message.model == "<synthetic>"` are Claude Code's own notices, not turns; ignored.

Golden fixtures for the parser (normal, compacted, malformed line, unknown schema field) live in `testdata/transcripts/`.
