# Caprock — Contracts

The wire-level and on-disk contracts: hook shim protocol, HTTP API, WebSocket frames, SQLite DDL and migrations, pricing table, runtime file, and the observed transcript shape. This file is the canonical home for every contract; other files link here instead of restating. Hive-side file formats (task files, mailbox messages, ledger) live in [05-orchestration.md](05-orchestration.md).

Conventions that apply to every contract here: JSON casing is **snake_case**; all money is **USD float**; all tokens are **int64**; everything is versioned under **`/v1`** from day one.

## Hook shim

- Single Go binary `caprock-hook` (same repo, tiny), installed to Caprock's data dir. The daemon brings `<data_dir>/caprock-hook` up to date on every start (`hooks.EnsureShim`): a `caprock-hook` beside the running `caprock` is copied in whenever the bytes differ; with none beside it (the desktop app ships `caprock` alone) an existing data-dir shim is replaced by a copy of the running `caprock`, which runs as the shim when started under that name. Each write is a temporary file in the data dir renamed over the shim, so Claude Code never finds it missing or half-written; on Windows a running shim is left and replaced on the next start. Before this, a shim a Homebrew install had put there in August was still feeding hooks to a 0.147.0 daemon in October.
- Registered in `~/.claude/settings.json` under events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`, `PreCompact`, `StopFailure`, `PermissionRequest`. Installer merges JSON non-destructively; `caprock hooks uninstall` reverts; back up the settings file before first write.
- Behavior (Phase 0–1: fire-and-forget): read stdin JSON → POST to `http://127.0.0.1:<port>/v1/hook` with `Authorization: Bearer <run-token>` and `X-Caprock-Ppid: <os.Getppid()>` → always exit 0 within a 1s budget. Never print to stdout (a broken shim must not affect the user's Claude session). If the daemon is down, drop silently.
- One server, one port: `/v1/hook` lives on the same listener as the API and UI (default **22776** on a fresh install; an existing install that never wrote `config.json` keeps its old **4173** origin, because a port is part of a browser origin and moving it would strand bookmarks and LAN-pairing tokens); `<data_dir>/runtime.json` holds `{port, token}`, written by the daemon, read by the shim per invocation.
- Phase 2 extended this protocol for **Stop events only** — request-response with a 5s timeout; see [05-orchestration.md § Stop-hook decision protocol](05-orchestration.md#stop-hook-decision-protocol-shim-upgrade-t19).
- Why a shim binary rather than Claude Code's native `type: "http"` hook: [ADR-009](08-decisions.md#adr-009--hook-transport-is-the-caprock-hook-shim-binary-not-claude-codes-native-http-hook-type).

### Hook payload (what the shim forwards, verbatim)

Claude Code sends one JSON object per event on the shim's stdin. Fields common to all events (per the hooks reference, verified 2026-08-18): `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `effort` (`{level}`), and for subagents `agent_id`, `agent_type`. The parent's hooks also fire for its subagents' tool calls, under the parent's `session_id`; when such a payload names no `agent_id`, hookd takes it from a `transcript_path` of the form `<session-id>/subagents/…/agent-<id>.jsonl`, so the call is the subagent's and not the main thread's. Event-specific fields the daemon reads:

| Event               | Fields consumed                                              |
| ------------------- | ------------------------------------------------------------ |
| `PreToolUse`        | `tool_name`, `tool_input`, `tool_use_id`                     |
| `PostToolUse`       | `tool_name`, `tool_input`, `tool_use_id`, `tool_response`    |
| `UserPromptSubmit`  | `prompt`                                                     |
| `Stop`              | `stop_reason`, `last_assistant_message`                      |
| `SubagentStop`      | `stop_reason`, `last_assistant_message`, `agent_id`          |
| `SessionStart`      | `source` (`startup`, `resume`, `clear`, `compact`, `fork`)   |
| `SessionEnd`        | `reason` (payload stored; only some reasons end the session) |
| `PreCompact`        | `trigger` (`manual`, `auto`)                                 |
| `StopFailure`       | `error` / `stop_reason` (rate_limit, overloaded, billing)    |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions`          |

**What is stored is the payload with its tool fields bounded** (`event.CapToolField`,
2026-10-13). The shim forwards the body verbatim; the daemon stores every field as
it came except `tool_input` and `tool_response`, which go through the rule the
transcript parser applies to its own copy of a call — one function, so the two
planes cannot drift. Before this the hook copy was stored verbatim up to the 4 MiB
body limit, and it is the copy that wins the dedup: hook tool results were 1.1 GB
of the owner's 2.2 GB database, mostly base64 screenshots and whole files. Per
field (`MaxToolField`, 32 KiB of JSON):

- **Base64 content is replaced by a marker at any size**: an image block's
  `data`, Claude Code's `file.base64` (a Read of an image), an MCP screenshot's
  `data` beside its `mimeType`, a `data:<type>;base64,` URI. The marker names the
  media type and decoded size: `[image image/png 512 KB not stored]` (`[file
  <type> …]` for anything not an image). The rest of the block — `type`,
  dimensions, `originalSize` — stays.
- **A string longer than the budget is clipped** on a rune boundary and ends
  `…[truncated <bytes dropped> bytes]`, plus `, <n> lines` when the dropped part
  held line breaks, so the Week's lines-added count still counts a large Write
  whole (`event.SplitClip`).
- **Short fields always survive.** An object's fields get the budget smallest
  first, so `file_path`, `command`, exit codes, `interrupted`, `agentId` and
  `gitOperation` are kept beside a huge `originalFile`; an array keeps elements
  until the budget is spent and ends with `[<n> more items not stored]`.
- **A value within the budget with nothing base64 in it is stored byte for byte**,
  without being decoded.
- **`tool_bytes` counts the response the tool handed back, not the stored copy**
  (`Event.ToolBytes`), so tool sizes are unchanged. It applies to every agent
  observed through hooks (today Claude Code); Codex output is clipped by its own
  importer (`codex.MaxToolOutput`).

Measured on a copy of the owner's database (2026-10-13): of 134,099 hook tool
rows, 6,099 change, and their payloads go from 1,229 MB to 388 MB — 841 MB less
for the same history. Rows stored before the cap lose their base64 too, once,
while the daemon is idle, and keep their text whole (§ Payload compaction and
auto-vacuum). The whole output of a clipped call is still in the agent's own
transcript.

**`PermissionRequest` is observed, and stored as `permission.prompt`**
([ADR-035](08-decisions.md), [ADR-036](08-decisions.md)). Claude Code fires it
as it draws a permission dialog; the shim forwards it fire-and-forget and never
answers it, so the dialog appears exactly as without Caprock. For a session
Caprock started, the daemon also queues it as a prompt that session waits on
(`GET /v1/agents/{id}/permission` returns the oldest, which is the dialog
Claude Code shows) until something answers it; a later hook never replaces an
earlier unanswered prompt. For every
session the stored event makes Now and the session page say *waiting for
approval* (naming the call; *waiting for your answer* for `AskUserQuestion`)
with the *waiting on you* badge, until the session's next event — or, in a
session Caprock started, until the dialog is answered there (§ Nudges) — and
is what a phone alert is sent on. A dialog dismissed with Esc fires no hook, so
in a session Caprock did not start the state holds until the next prompt.

The daemon stores the raw payload untouched in `events.payload`; unknown events and unknown fields are logged and ignored, never fatal ([06-engineering-rules.md](06-engineering-rules.md)).

**`SessionEnd` is not always the end, and each reason is stored as itself.**
`exit` and anything unrecognised end the session. `clear`, `prompt_input_exit`
and `other` leave it running (ADR-028's reasoning: a session wrongly closed
vanishes from the dashboard with its owner still typing into it, while one
wrongly left open closes itself within the hour). What each becomes on the
timeline:

- **`clear`** → `context.clear`. Its own kind, not `context.compact`: a compact
  summarizes the context and keeps its substance, `/clear` discards it. Sharing
  the compact's kind made the dashboard narrate "compacting context" at a
  session that had just been cleared.
- **`prompt_input_exit`, `other`** → `session.continue`. Neither touches the
  context, so neither may claim a context event happened, and neither may be
  stored as `session.end`, which rollup reads as "retire this session".
- **`exit` and the rest** → `session.end`, which retires the session.

**`/clear` replaces a session rather than ending one.** Claude Code keeps the
process and starts a fresh session id, so the `SessionStart` that follows
carries `source: "clear"` and the *new* id, while the `SessionEnd` before it
carries the old one. The replacement is keyed off the **start**, since only it
names the session that must survive. The superseded sibling is retired by pid
(`store.EndSupersededSiblings`): it cannot be caught by the staleness sweep,
because the sweep judges a session by whether its process is alive and the two
share that live process — so the old row stayed `active` forever and one editor
appeared on the dashboard as two working sessions. A process runs one
conversation at a time, so a sibling on the same pid is finished by definition;
`pid = 0` means "unknown" and is never matched.

**In a session Caprock started, the replacement is Caprock's and gets the
terminal.** The process is the one Caprock spawned, so the new row takes
`owned = 1` with the spawn's `worktree`, `spawn_command`, `subscription` and
`chat` (`store.InheritOwned`, in the same transaction; a replaced session that
is not owned passes nothing on). After the commit the recorder tells the daemon
(`Recorder.OnClear`), and the agent manager files the spawn's terminal under the
new id as well (`agents.Manager.Follow`): `/v1/agents/{new}/…` — terminal
socket, input, signal, permission — reaches the same PTY, while the spawn's id
keeps answering and the process, its pty-host and `OwnedRunning` stay under it.
What the conversation is doing (pending prompts, the queue, nudges, idle-end's
last activity, whether a tab is open) is read under the newest id
(`Agent.Current`). When the process exits, every id filed under it ends with
the exit code and gets a `session` frame. A daemon that reattaches a pty-host
finds the newest session of the process from the rows (`store.ClearSuccessor`:
`parent_session` links whose ends share the pid; a fork runs in another process
and is never followed), files the terminal under it and leaves the spawn's own
row ended rather than reviving it. `SessionSummary` carries `pid` (omitted when
unknown), which is how the dashboard tells a `/clear` from a fork
([04-ui.md](04-ui.md) § One card per conversation).

**Dedupe keys.** hookd keys events as `pre:<tool_use_id>`, `post:<tool_use_id>`, `prompt:<prompt_id>`; ingest derives the *same* keys from transcript `tool_use` / `tool_result` blocks and `promptId`, and keys assistant turns as `msg:<message.id>`. `(session_id, key)` is unique in the store, so whichever plane arrives first wins and the other is a no-op — this is how "dedupe against hook events by session_id" is implemented, and it also makes re-reading a transcript after restart idempotent. Stop / SubagentStop / SessionStart / SessionEnd / PreCompact are keyless (never deduped).

**A turn is paid once across sessions.** The key is unique per session only, and a fork's transcript repeats its parent's turns under the fork's own session id (see [Transcript JSONL](#transcript-jsonl-observed-shape)). So a `turn.assistant` whose `msg_id` another session already holds *with usage* is stored with zero tokens and `cost_usd = 0` (`store.TurnPaidElsewhere`, migration 0029): the row stays in the fork's timeline with its prose and counts as a turn there, and the response is billed once, to the session that stored it first. A copy with no usage does not count as the payer, so an empty copy stored first cannot stop the original being priced. `rollup.RepairForkedTurns` applied the same rule once to rows stored before it (meta `forked_turns_repaired`): per message id the row with the most tokens pays, ties to the earliest, and `session_stats` / `daily_stats` move by what is taken off.

### settings.json registration shape

The installer writes, for each of the nine events, a matcher-less entry (`matcher` omitted — `UserPromptSubmit` and `Stop` do not accept matchers) of the form `{"hooks":[{"type":"command","command":"<data_dir>/caprock-hook","timeout":5}]}` and leaves every other key, every pre-existing hook, **and the user's key order** untouched (ordered-JSON merge). The registered command is written with **forward slashes and double quotes**, on every platform: Claude Code runs hooks through a POSIX shell, where a backslash is an escape, so a Windows path reached it as `C:UsersVolasAppData…caprock-hook.exe` and every hook failed while the dashboard — still fed by transcript tailing — looked healthy. Windows accepts forward slashes in every API, and the quotes keep a path with a space (`C:/Program Files/…`, or the macOS `~/Library/Application Support/…`) from splitting into two words. Either fix alone is insufficient. `statusLine.command` is written the same way and had the same defect. Entries in any earlier form — bare, quoted, backslashed — are still recognised as ours, so an upgrade neither reports a working install as missing nor overwrites a line the user repaired by hand. When no `caprock-hook` binary sits beside the `caprock` executable, the registered command is `<caprock> hook` (a hidden subcommand running the same shim code). **Self-repair at daemon start** (`hooks.RepairPaths`, run only by a released binary named `caprock`, never a `dev` or `git describe` build, which would point the hooks at a worktree): an entry of ours whose program is missing or is a different file from the one an install would register now (an uninstalled Homebrew `caprock-hook`, say) is pointed at the current command; where the event already runs the current one, the stale entry is removed instead, so no event fires twice. A user's own hooks are never touched, and nothing is rewritten when the current shim does not exist either. Uninstall removes only entries whose `command` points at a Caprock shim (exact path, or basename `caprock-hook[.exe]`, or `<caprock> hook`) and drops empty containers it leaves behind. Backups are `settings.json.caprock-backup-<unix-ts>` next to the original, taken before a modification **whenever the current content is not already captured by an existing backup** — a backup taken once and never refreshed goes stale (the audited machine had a 10 July snapshot of a file last edited 20 August) and would restore a file the user no longer recognises. Identical content is never snapshotted twice, so repeated runs over an unchanged file add nothing. A same-second second backup gets a `-2` suffix rather than overwriting its predecessor. At most 5 are kept: the oldest (the closest thing to a pre-Caprock state) plus the most recent 4. `caprock hooks restore` lists them and restores one by path, snapshotting the current file first so the restore is itself undoable; it refuses an unparsable backup. An unparsable settings.json is never modified.

## HTTP API (daemon, loopback)

### Who may connect, and from where

Loopback by default and nothing else. `caprock up --lan` opens a **second**
listener on one named private IPv4 address — never `0.0.0.0` — and from that
moment one rule decides every request: **anything that did not come from this
machine must carry a device token** ([ADR-029](08-decisions.md)).

- **Loopback is unaffected.** No token, no change, no existing client touched.
- **Unless a relay put it there.** A proxy or tunnel on the machine
  (cloudflared, ngrok, Caddy, nginx, `tailscale serve`, `ssh -R`) connects from
  127.0.0.1 on a visitor's behalf, so loopback alone is not the owner
  (`isLocal`, `internal/api/lanauth.go`). A loopback request is **relayed** when
  it carries any of `Forwarded`, `Via`, `X-Real-IP`, `True-Client-IP`, or a
  header starting `X-Forwarded-`, `CF-`, `Tailscale-`, `Ngrok-` or `X-Ngrok-`
  (presence only; values are never read), or when its `Host` hostname is not
  `localhost`, `*.localhost` or a loopback IP (empty included; the port is not
  compared, so `ssh -L 8080:127.0.0.1:22776` stays the owner). A relayed
  request is a device: it needs a valid `X-Caprock-Device` token (or the
  WebSocket subprotocol) and gets exactly its role, `401` without one, and
  loopback-only handlers (`/v1/pair/*`) refuse it. With network access off
  there is no pairing store, so every relayed `/v1` request is `401`. The
  dashboard's files still load. Every client of ours — CLI, shim, statusline,
  dashboard, Vite's dev proxy — addresses 127.0.0.1 or localhost and sends none
  of these headers. A relay set up to strip them all and rewrite `Host` to
  localhost cannot be told apart from a local client.
- **From the network, three things are reachable without a token:** `POST
  /v1/pair`, the dashboard's own files (they carry no figures), and nothing
  else. Every other `/v1` path is closed by default, so a route added later is
  private until someone decides otherwise.
- **The token is a header**, `X-Caprock-Device`, or — on `/v1/live`, where a
  browser cannot set one — the WebSocket subprotocol `caprock.device.<token>`,
  echoed back to complete the handshake. Never a query parameter: that writes a
  bearer token into every access log and browser history entry on the device.
- **Not stored unless the owner asks.** Paired devices survive a restart; the
  decision to listen does not, unless `lan_keep_on` is true in `config.json`
  (ADR-060, off by default), when the daemon turns it on at start as `--lan`
  would. Settable at startup with `--lan` or at runtime with `POST
  /v1/pair/lan` (`{on: bool, keep?: bool}`, loopback-only; answers
  `{enabled, url?, keep_on}`) — a restart-only switch is reachable only from a
  terminal on the machine, which is the one place the person who wants it is
  not. `keep` is stored only with `on: true`; `on: false` always clears
  `lan_keep_on`. `on: true` while already listening also opens the Tailscale
  listener when a Tailscale address has appeared since and none is listened
  on, leaving the first listener alone.
- **A token makes a device a reader, not the owner.** A paired device may make
  only the reads named in `pairedDeviceRoutes` (`internal/api/lanauth.go`),
  matched on method and route pattern: `GET`/`HEAD` of `/v1/sessions`,
  `/v1/sessions/{id}` and its `events`, `notes`, `todos` and `diff`, `/v1/notes`,
  `/v1/stats/summary`, `/v1/stats/limits`, `/v1/stats/daily`, `/v1/stats/trends`, `/v1/window-stop`, `/v1/events`, `/v1/history`,
  `/v1/status`, `/v1/storage`, `/v1/update`, `/v1/settings`, `/v1/premium`, `/v1/gemini`,
  `/v1/pricing`, `/v1/live`, `/v1/tasks`, `/v1/tasks/{id}`, `/v1/approvals`,
  `/v1/statusline/{id}`, `/v1/agents/{id}/permission`, `/v1/agents/{id}/queue`, `/v1/queue`,
  `/v1/chats`, `/v1/chats/{id}/files` and `/v1/chats/{id}/file` (§ Chats),
  `/v1/work` and `/v1/sessions/{id}/ci/stats` (the phone home's Releases:
  the board and one repository's Pipeline answer, composed by the daemon
  from the GitHub reads it keeps with its own token — the token never
  leaves it, and a relay phone reads both through the end-to-end channel),
  `/v1/sessions/{id}/commands`, `/v1/sessions/{id}/files`, `/v1/projects`,
  `/v1/projects/ops`, `/v1/projects/{id}/worktrees`, `/v1/projects/{id}/changes`,
  `/v1/projects/{id}/changes/diff`, `/v1/projects/{id}/file`,
  `/v1/projects/{id}/files`, `/v1/projects/{id}/image`, `/v1/brain`, `/v1/brain/status`,
  `/v1/brain/spend` and `/v1/brain/nodes/{id}`. Everything else is `403` — every `POST`, `PUT` and
  `DELETE` (spawn, input, signal, paste, settings, tasks, approvals,
  orchestrator, hive, licence, pairing, shutdown), and three `GET`s that are
  not reads: `/v1/agents/{id}/term` (its socket types into the session), and
  `/v1/browse` and `/v1/recent-dirs` (directory listings for starting one). An
  allowlist, so a route added later is closed to a paired device until it is
  named. `GET /v1/settings` omits `license_key` for a paired device. Loopback is
  unaffected. `GET /v1/pair/me` is on the list too: it answers `{role}` —
  `"owner"` on loopback, else `{role: "viewer"|"controller", id, name, via,
  anywhere?, app?, installed?}`, where `via` is how this request arrived (below),
  `anywhere` is true while access from anywhere is on, and `app` (sent with
  it) is the phone's page, so a Wi-Fi link's notice names where the app is.
  A computer (below) also gets `kind: "machine"`, and `pending: true` while
  its owner has not allowed it. `DELETE /v1/pair/me` is open to every
  paired device, waiting or not: it removes the asking device itself (its
  token stops, its sockets close) and answers `{revoked: 1}`; on loopback it
  is `400` — the machine is no device (ADR-067).
  `?app=1` or `?app=0` reports whether the phone runs as the installed app
  (2026-10-14); the machine stores it per device as `app` in `devices.json`
  (saved when it changes), lists it in `GET /v1/pair/state`'s `devices`, and
  answers it as `installed`. Any other value records nothing. A label for the
  owner's checklist; it never decides access.
- **How a device last arrived** (`via`, 2026-10-14): the gate records it on
  every request a device makes, and at pairing — `relay` for a request on
  loopback carrying `Via: …caprock-remote…`, `tailscale` for a peer in
  100.64.0.0/10, `lan` for any other network peer; a request it cannot tell
  apart (another tunnel on loopback) records nothing. Stored per device in
  `devices.json` (`via`, absent until first recorded), saved when it changes
  (not per request, unlike `last_seen`), and listed in `GET
  /v1/pair/state`'s `devices`. A label for the owner's list and the phone's
  notice; it never decides access.
- **A controller may also work on sessions** ([ADR-034](08-decisions.md)). A
  device pairs with the role its code carries — `POST /v1/pair/code` with
  `{role: "controller"}`, the owner's tick *This phone can type and start
  agents*, else a viewer (amended 2026-10-14) — and the owner changes it with `PUT
  /v1/pair/devices/{id}/role` (`{role: "viewer"|"controller"}`, loopback-only,
  `400` for any other role, `404` for an unknown id, and while network access
  is off it edits `devices.json`). `role` is stored per device in
  `devices.json` (absent = viewer, which every file written before roles
  reads as) and listed in `GET /v1/pair/state`. A controller may additionally
  make exactly the requests in `controllerRoutes` (`internal/api/lanauth.go`):
  `POST /v1/agents`, `GET /v1/agents/models`, `GET /v1/agents/catalog`, `GET /v1/recent-dirs`,
  `GET /v1/browse`, `GET /v1/browse/stat` and `GET /v1/browse/repos` (rooted inside home, see below), `GET /v1/sessions/{id}/relay`, `GET /v1/agents/{id}/term`,
  `POST /v1/agents/{id}/input`, `POST /v1/agents/{id}/signal`,
  `POST /v1/agents/{id}/permission`, `PUT /v1/sessions/{id}/name` (a label in
  Caprock's own database), `PUT /v1/sessions/{id}/needs` (a mark in the
  daemon's memory, § Needs you and Done), the message queue (`POST /v1/agents/{id}/queue`,
  `PATCH` and `DELETE /v1/agents/{id}/queue/{qid}`, `POST /v1/agents/{id}/queue/{qid}/send`),
  `POST /v1/paste`, `POST /v1/tasks/{id}/approve` and `/reject`, saving to
  and deleting from the Inbox (`POST /v1/inbox`, `DELETE /v1/inbox/{id}`,
  § Inbox), archiving and deleting a chat (`PUT /v1/chats/{id}/archived`,
  `DELETE /v1/chats/{id}`: chats only, ADR-071 amending ADR-037), AI;DR on
  an answer (`POST /v1/events/{id}/tldr`, § AI;DR, ADR-072), sending a
  bug report (`POST /v1/support`, § Report a bug, ADR-073), and — to
  start work from the phone (2026-10-05, [21-app.md](21-app.md) decision 8) —
  `POST /v1/projects`, `PATCH` and `DELETE /v1/projects/{id}`, and `POST` and
  `DELETE /v1/projects/{id}/worktrees…` (see § Projects and shells for the
  folder rules), a private module the admin key opens (`GET /v1/admin`, `GET
  /x/<id>/…` and its document store, § Private modules, 2026-10-21), and — to finish the work (2026-10-06) — `POST
  /v1/projects/{id}/changes/stage`, `unstage`, `discard`, `commit`, `push`,
  `pull` and `fetch`, in a worktree that resolves under home (§ Changes). From a device a clone URL must also begin `https://` or
  `git@` (`400` otherwise, before git runs). Everything
  else stays `403` for a phone (a computer's wider list is below): settings, pairing, hive, tasks creation
  and verify, orchestrator, hooks install, shutdown, update check, report
  test, Gemini ask, `open-terminal`, the editor routes, `POST /v1/sessions/remove`, and every
  shell route — `POST`/`GET /v1/shells`, and a shell's terminal, input and
  signal through the agent routes a controller otherwise has (a shell from the
  phone is P1).
- **What a controller's `POST /v1/agents` may say** (`controllerSpawnRefusal`):
  `cwd` must be absolute and, after `filepath.EvalSymlinks`, the home directory
  or below it — a project outside home is refused even where sessions have run. With `create: true` a missing `cwd` passes when its
  parent resolves inside home (the agent manager makes one level). `command`
  and `args` are refused unless empty. `chat: true` is allowed with no `cwd`
  (the daemon picks the chat's folder) and refused with one; a `cwd` that is
  one of Caprock's chat folders passes, so a phone can continue a chat in
  place (ADR-071, amending ADR-034). Every
  `permission_mode` is allowed, `bypassPermissions` included (ADR-034).
  Refusal is `403` with `{error}`. A session started from a device is logged
  with the device's id and name.
- **A computer** ([ADR-067](08-decisions.md)) is another machine's Caprock,
  paired with a code for a computer (`POST /v1/pair/code {kind:
  "machine"}`, below) and stored in `devices.json` with `kind: "machine"`.
  The kind comes from the code, never from the redeeming request. It is
  stored `pending: true` and, until the owner allows it (`POST
  /v1/pair/devices/{id}/allow`), its token reaches `GET /v1/pair/me` and
  `DELETE /v1/pair/me` and nothing else: every other `/v1` request is `403`
  with `error` *this computer is waiting to be allowed on the machine
  Caprock runs on*; its role reads as `viewer` (`RoleOf`) and its terminal
  frames are refused. Allowed, it is a controller that may also make the
  requests in `computerRoutes` (`internal/api/lanauth.go`): `POST` and `GET
  /v1/shells` (and a shell's terminal, input and signal through the agent
  routes), `GET /v1/hive/starter`, `POST /v1/hive`, `POST /v1/tasks`, `POST
  /v1/tasks/{id}/verify`, `POST /v1/orchestrator/start` and `/stop`, `GET
  /v1/agents/custom`, `GET /v1/activity`, `GET /v1/overlap`, `GET
  /v1/update/busy`, `GET /v1/github/actions-usage` and `/statuspage`, a
  session's `prs`, `ci`, `branches`, `ci/jobs/{job}/log`, `ci/release`,
  `ci/main` and `ci/stats`, `POST /v1/sessions/{id}/prs/{number}/rerun` and
  `/update-branch`, `GET /v1/projects/{id}/branches`, `copies`, `cleanup`,
  `POST /v1/projects/{id}/copies/remove`, `cleanup` and `cleanup/restore`,
  `GET /v1/projects/scan`, `POST /v1/projects/merge` and `POST
  /v1/projects/{id}/split`. A phone's limits do not apply to it
  (`phoneLimited`): `POST /v1/agents` may name any folder, `command`, `args`
  and `chat`; the folder picker, `GET /v1/browse/stat`, `GET
  /v1/browse/repos` and `GET /v1/recent-dirs` use the machine's own root;
  projects, worktrees and changes may be outside home; a project's setup
  command may be set. It stays `403` on everything the machine keeps, whatever
  the role: `/v1/pair/*` but `me`, settings writes (`PUT /v1/settings`,
  Telegram, GitHub connect, custom agents, subscriptions, Second Brain's
  settings), `POST /v1/footprint/orphans/stop`, `POST /v1/resources/reap`,
  `POST /v1/system/memory/end-idle`, `POST /v1/system/memory/restart`,
  `POST /v1/shutdown`, `POST /v1/update/check`, `POST /v1/hooks/install`,
  `open-terminal`, the editor routes, `POST /v1/sessions/remove`,
  `/v1/machines` and `/v1/m/…`. Rule 7 is unchanged: the agent manager
  starts, types into and signals only what this daemon started.
- **`GET /v1/browse` from a controller** is rooted at the owner's browse root
  when that resolves inside home, else at home; a `dir` above it, outside it or
  through a symlink out of it is `404`, as on the machine, and an entry that
  links out of it is not listed. `GET /v1/recent-dirs` from a device lists only
  folders under home.
- **The terminal socket from a device** admits the LAN origin and takes the
  token as the `caprock.device.<token>` subprotocol, as `/v1/live` does. Before
  every frame a device sends, its role is read again (`pairing.Store.RoleOf`);
  once it is not a controller — demoted, revoked, or network access turned off
  — the socket closes with `1008` and the frame is not written.
- **A device's sockets close when it is removed or its role changes**
  (ADR-067). Every `/v1/live` and terminal socket (v1 and v2) a device opens
  is held by the device's id; `DELETE /v1/pair/devices/{id}` (Deny, Remove,
  `caprock machines deny|revoke`), `DELETE /v1/pair/devices/all`, `PUT
  /v1/pair/devices/{id}/role` and `DELETE /v1/pair/me` close them at once
  with `1008` and the reason *this device was removed or its access changed
  on the machine*. The device reconnects and the gate answers it as it now
  stands. Before this, `/v1/live` kept streaming to a removed device until it
  reconnected.
- **Refusal is `401` with `{error, detail}`** for a device that has not paired,
  and `403` with the same shape for a paired device asking for more than its
  role allows — the `detail` tells a viewer where control is granted — not a
  redirect: the caller is usually `fetch()`, and a redirect to HTML becomes a
  parse error three frames later.

**Which address.** One private IPv4 address (RFC 1918), never link-local, never
public. Tailscale's 100.64.0.0/10 is admitted **only on Tailscale's own
interface** — one named `tailscale*` (Linux, Windows) or carrying an address in
Tailscale's IPv6 prefix `fd7a:115c:a1e0::/48` (macOS, where it is a `utunN`).
The block is carrier-grade NAT, which Tailscale borrows; on any other interface
it is an address shared with every customer behind the same carrier, and other
VPNs borrow it too. When a Tailscale address exists it is preferred, and
`GET /v1/pair/state` says so with `tunnelled: true` (`internal/lan`).
When the machine has both kinds, LAN access listens on one of each (WP-15,
ADR-034 amended 2026-10-06), and `GET /v1/pair/state` lists them in
`addresses: [{url, kind}]`, `url` first, `kind` one of `lan`, `tailscale`
or `magicdns` — the last the Tailscale address by its MagicDNS name, from
`tailscale status --json` when the CLI answers within 2 s and the name is that
address's. The Host and Origin checks admit exactly these names. A code works
on any of them; a phone's token is kept per address (browser storage is per
origin), so each address pairs once. A Tailscale address appearing later
(Tailscale installed while LAN access is on) is listened on at the next `POST
/v1/pair/lan {on: true}`, which the pairing panel sends when it sees one.
`GET /v1/pair/state` also carries `tailscale: true` when the machine has a
Tailscale address now — from the interface list, listened on or not, while
access is off too — and `keep_on`, the stored `lan_keep_on` (ADR-060).

**Pairing endpoints.** `GET /v1/pair/state`, `POST /v1/pair/code`,
`DELETE /v1/pair/code` and `DELETE /v1/pair/devices/{id|all}` are
**loopback-only, enforced in the handler** rather
than by the gate: a paired tablet is somewhere to read figures, not a second
control room, and it must not be able to admit a third device or revoke the
laptop that let it in. `PUT /v1/pair/devices/{id}/role` is loopback-only the same
way: a controller cannot promote another device, or itself. `POST /v1/pair/code`
takes an optional `{role: "viewer"|"controller"}` (no body, or no role, is a
viewer, as `caprock pair` and `caprock remote` send; any other role, or a
body that is not JSON, is `400`) and answers `{code, role, expires_in_sec,
url, remote?}`; `GET /v1/pair/state` names the outstanding code's role as
`code_role`. The device pairing with that code gets that role; nothing the
device sends names one. `{kind: "machine"}` issues a code **for a computer**
(ADR-067; any other `kind` but none or `""` is `400`): its role is
`controller` whatever `role` says, it turns access from anywhere on first if
it is off (`501` in a build without the relay, `409` when that fails), and
the answer adds `kind: "machine"`; `GET /v1/pair/state` names it as
`code_kind: "machine"` (absent for a phone's code). Each listed device
carries `kind` (`"machine"`, absent for a phone) and `pending` (true while a
computer waits). `POST /v1/pair/devices/{id}/allow` (loopback-only, no body)
allows a waiting computer — `200 {id, role: "controller"}`, `404` for an
unknown id or one not waiting; while network access is off it edits
`devices.json`. Deny is `DELETE /v1/pair/devices/{id}`. Every change to the
guest list (a pairing, a removal, a role, an allow) publishes a `devices`
frame on `/v1/live` with `data: {}`: the machine's own dashboard re-reads
`GET /v1/pair/state` and asks about a computer that waits; the frame names
nothing, so a phone on the stream learns no name. `POST /v1/pair`
takes `{code, name}` and returns `{token, id, name}` — the name prefixed
`This computer · ` when the request came from the machine's own network
address; it is the one call a device makes before it is trusted, and
it answers the same way for a wrong, expired, exhausted or never-issued code,
because every distinction tells a guesser how close they are.

**Access from anywhere (ADR-058).** `POST /v1/pair/remote` (`{on, relay?,
app?}`, loopback-only) turns it on or off, remembered in `remote.json` (mode
0600, with the machine's two keys) and answers the state; `GET /v1/pair/state`
and `POST /v1/pair/code` carry it as `remote: {enabled, status
(off|connecting|online|offline), error?, phones, relay, app, host_id, link?}`,
where `link` is the pairing link the QR draws — the phone's page with `r`
(relay), `h` (host id), `k` (static key), `c` (the live code) and `n` (name)
after the `#`. `enabled` at the top of the state is the network listener
alone; the guest list is live whenever either is on. Requests from the relay
arrive on loopback with `Via: 1.1 caprock-remote` and are gated as a paired
device. The relay's wire is `internal/remote/wire.go`, the channel's frames
`internal/remote/proto.go`. A relay treats a machine it has not heard from
(the daemon pings every 25 s) for 75 s as gone: a phone arriving for it, or
sending to it, is closed with 4404 and the stale connection dropped (4408
on the hosted relay), never spliced to a machine that went to sleep.

**Other computers (ADR-067).** A daemon reaches another machine's daemon as
that machine's paired device, over the same relay channel a phone uses —
the target runs its ordinary Host and gate, and pairs it as a computer
(above). The controller's side:

- **`machines.json`** in the data directory, mode 0600 (written atomically;
  on Windows the mode is not enforced and the file is in the user's
  profile, as `devices.json` is): a JSON array of `{id, key, relay, name,
  token, device_id, added_at}` — `id` the target's relay id (its Ed25519
  key, base64url), `key` its X25519 static key (base64url, pinned by every
  handshake), `relay` the `wss://` address from its link, `name` this
  machine's label for it (40 characters, printable), `token` this machine's
  device token there, `device_id` the target's id for this device, and
  `added_at` unix milliseconds by this machine's clock. An entry missing
  `id`, `key`, `relay` or `token` is skipped on read; a file that is not
  JSON reads as no computers (logged), never as a crash. Never in
  `config.json`.
- **The link** a computer is paired with is `remote.PairLink`'s (above):
  `ParsePairLink` takes the whole link, the same wrapped in `<>` or quotes,
  or only the part after `?`. `r` must pass `CheckRelayURL`, `h` must be an
  Ed25519 key, `k` 32 bytes, `c` digits only; `n` is optional. Pairing
  needs `c`; it is redeemed with `POST /v1/pair` `{code, name}` through the
  channel, and the target's `401` and `409` are told apart (wrong code;
  pairing not open there).
- **The client side of the channel** (`remote.Client`) speaks
  `internal/remote/proto.go` as the phone does: the Hello is `{v: 1}`, the
  Welcome's `version` and `name` are kept, stream ids are odd and count up
  from 1, at most 64 open, and bodies go in frames of at most 60 KB.
  Requests carry only the headers in `requestHeaders`; every request a
  computer makes sets `X-Caprock-Device` to its token there, and every
  socket offers `caprock.device.<token>` after the caller's protocols.
  `Cookie`, `Origin`, `Referer`, `Authorization` and `Sec-*` from the local
  caller are removed first. One attempt (relay, handshake, Welcome) is
  bounded by 10 s; a failed one backs off 1 s doubling to 30 s, during which
  a request is answered at once with the last failure. An open channel
  pings the relay every 25 s, is dropped after 60 s unheard, and closes
  after 90 s with no stream open. A stream whose reader falls 512 frames
  behind is cancelled (`KindCancel`), never the channel. Its states are
  `idle`, `connecting`, `online`, `offline` (4404, the relay unreachable,
  or a drop), `refused` (the target hung up on the handshake: another key)
  and `closed`; `internal/peers` adds `revoked` when `GET /v1/pair/me`
  answers 401, cleared when a later check answers 200, and `pending` while
  it answers `pending: true`.
- **`GET /v1/machines`** answers `{machines: [{id, name, relay, added_at,
  status, error?, version?, role?, kind?, last_seen?, streams}]}`, in the
  order added, never a token. `?check=1` first asks each computer `GET
  /v1/pair/me` through its channel, at once, for 12 s at most. **`POST
  /v1/machines`** `{link}` pairs (60 s at most) and answers that computer's
  entry: `400` for a link that does not parse, carries no code, names this
  machine, or a code the computer refused; `409` when the computer is not
  accepting pairings; `503` offline or relay unreachable; `502` refused
  (another key) or anything else; `504` out of time. The name it gives the
  target is this machine's host name without `.local`. **`PATCH
  /v1/machines/{id}`** `{name}` renames it here (`400` empty, `404`
  unknown) and answers the entry. **`DELETE /v1/machines/{id}`** asks the
  computer to drop this machine (`DELETE /v1/pair/me`, 10 s at most, best
  effort), deletes it and its token here, and answers `{forgotten: true,
  released}`.
- **The proxy `/v1/m/{id}/{path…}`**, any method: `path` is a path on that
  computer's API (`v1/…` or `healthz`, else `404`), carried with the query
  through its channel as this machine's device there. HTTP goes through
  `httputil.ReverseProxy` on the channel and is streamed as it arrives;
  `Cookie`, `Origin`, `Referer`, `Authorization` and `Sec-*` never travel.
  A WebSocket (`Upgrade: websocket`) is opened there first — a refusal there
  answers here as its HTTP status (`4000 + status`) — then accepted here and
  bridged message by message; the caller's subprotocols are offered there
  minus any `caprock.device.*`, and only the protocol the computer chose is
  echoed, never a device token; a close there closes here with its code (a
  dropped channel, 1006, drops the local socket). Errors: `404 {error: "no
  such computer"}`; `503 {error, status: "offline"}`; `502 {error, status:
  "refused"}`; a computer that answers `401` is asked `GET /v1/pair/me` once
  and, when that says this machine was removed, the answer is `403 {error,
  status: "revoked"}`; while it reads `revoked`, each request asks again
  before forwarding and goes through once it is allowed back. A waiting
  computer's `403` passes through.
- **Loopback only, not transitive.** `/v1/machines` and `/v1/m/…` refuse
  anything but this machine's own clients in the handlers (`403`, or the
  gate's `401` for a relayed request with network access off) and are on no
  device's allowlist, so a phone or a computer paired with this machine
  gets `403` there. `501` in a build without them.
- **The CLI** (`cmd/caprock/machines.go`), against the local daemon:
  `caprock machines` / `ls` (the computers this one reaches, checked, and
  the computers that reach this one from `GET /v1/pair/state`), `add
  <link>` (`POST /v1/machines`), `forget <name|id>`, and for the computers
  that reach this one `pending`, `allow <name|id>` (`POST
  /v1/pair/devices/{id}/allow`), `deny <name|id>` (a waiting one) and
  `revoke <name|id>` (`DELETE /v1/pair/devices/{id}`). A name matches case
  insensitively; two of one name are refused and named by id. `caprock pair
  --computer` issues a code for a computer, prints `caprock machines add
  '<link>'` for the other computer, and — when stdin is a terminal and
  without `--no-wait` — waits until the code expires (plus 30 s) for a new
  waiting computer and asks `"<name>" wants to control this computer.
  Allow? [y/N]`, allowing on `y`/`yes` and removing it otherwise. On Linux,
  when `loginctl show-user <user> --property=Linger --value` answers `no`,
  it and `caprock service install` print how to run `loginctl enable-linger
  <user>`; neither runs it.
- **Relay counters.** `remote.State` (the Host) and `remote.ClientState`
  count relay messages and bytes each way (`msgs_in`, `msgs_out`,
  `bytes_in`, `bytes_out`) since the daemon started, for OQ-14. Not in any
  API answer yet.

**The way back to a paired phone (2026-10-15).** `GET /v1/pair/state`
carries `telegram: true` when a Telegram bot and chat are set up.
`POST /v1/pair/send-link` (loopback-only, no body read) sends one message to
that chat — the bridge's outbox, else the report bot, as the alerts do: the
phone's page `remote.app` with a trailing `/` and one line on Add to Home
Screen. The address is the daemon's own, never the request's, and carries no
code, key or token. It answers `{sent: "telegram", link}`; `403` off the
machine (a paired phone included), `501` in a build without the relay,
`409` with no bot set up, `502` with Telegram's error. No new destination:
the chat is the one the owner connected (ADR-047).

- `DELETE /v1/pair/code` withdraws the outstanding code and answers
  `{cleared: true}` whether or not there was one — the dashboard's **Cancel**,
  so a code hidden from the owner is not still valid behind them.
- **While network access is off**, `GET /v1/pair/state` lists the devices saved
  in `devices.json` (without tokens), and `DELETE /v1/pair/devices/{id|all}`
  removes them from that file (`404` for an unknown id). Off is not forgotten:
  every saved device is let back in when network access is turned on, so the
  owner sees and edits that list without opening the door first. Without a
  data directory (tests) the delete is still `409`.
- **The scanned link** is `http://<address>:<port>/#/pair?code=NNNNNN`. The
  code rides in the fragment, which the browser never sends to the server; the
  pairing page reads it, redeems it once with `POST /v1/pair`, and replaces the
  address with `#/` so the phone's history does not keep a spent code.

Codes are six digits, single-use, valid five minutes, and burned after five
wrong guesses (`internal/pairing`, unchanged since it was written). Device
tokens are full length and do not expire; revocation takes effect on the next
request. The guest list lives in `devices.json` at mode 0600, beside the
licence key and the report bot token, and never in `config.json`.

### SessionStart handoff

A `SessionStart` hook whose `source` is `startup` is answered with the last
substantial thing an agent said in the same repository, in the shape Claude
Code reads:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
```

Verified against a live session, not only against the documentation — the
payload field is `source`, though the docs also name `startup_reason`. Any
other source (`resume`, `clear`, `compact`, `fork`) gets `204` and the session
starts unchanged.

Bounds: 400 runes minimum (below that a passage says nothing about where the
work stood), 1,200 maximum (Claude Code documents no cap and is reported to
drop an oversized reply silently), 14 days maximum age. The shim waits 1.5s for
this reply — shorter than the Stop budget, because it sits in front of a prompt
that has not appeared yet — and a daemon that cannot answer in time simply says
nothing. [ADR-030](08-decisions.md). A session opening in the filesystem root,
the home directory or the temp directory (`store.NotAProject`) gets nothing and
runs no lookup.

A served handoff also carries the repository's Second Brain (§ Second
Brain), after the passage, in two parts each with a budget of its own
(`store.BrainHandoff`): first its **current decisions** — the decisions no
newer memory supersedes — newest first, at most 15, one line each `- #id
title`, in 1,500 runes; then up to five of its **other memories**, pinned
first then newest, **at most one per source session** (so one long session
cannot fill it), a decision already listed and a superseded memory left
out, each `- kind: title — summary` with the summary clipped to 160 runes,
in 700 runes. With **no passage** recent enough (none of 400 runes or more
within 14 days), the decisions and memories go alone; nothing goes only
when there is neither. The whole reply is then at most 1,200 + 1,500 + 700
runes and two headings, about 3,500. How many memories went is recorded on
the session (migration 0058: `ALTER TABLE sessions ADD
COLUMN handoff_brain INTEGER NOT NULL DEFAULT 0` and `CREATE INDEX
idx_sessions_handoff_brain ON sessions(started_at) WHERE handoff_brain >
0`), so the Second Brain status can say how often agents start with its
memories (§ Second Brain, `handoff`), and said on the live socket as a
`brain` frame `{op: "handoff", session, project, memories}` (§ Second
Brain, Live) so the sidebar can show them going into the session's tab.
The length of the reply's `additionalContext`, in runes, is recorded too
(migration 0069: `ALTER TABLE sessions ADD COLUMN handoff_runes INTEGER NOT
NULL DEFAULT 0`; 0 when nothing was handed), so delivery can be measured.

**Measuring it.** Whenever there is anything to hand over — a passage, or,
since 2026-10-22, Second Brain's decisions and memories alone — the session
records whether it got it: `sessions.handoff` is `1` (served) or `2` (held back);
`0` means nothing was there, and those sessions are in neither group
(migration 0028: `ALTER TABLE sessions ADD COLUMN handoff INTEGER NOT NULL
DEFAULT 0`). `settings.memory_holdout_pct` (0–50, default 0; a value outside
is a 400) holds the handoff back from that share of such sessions, drawn at
random so the two groups differ only by the handoff. `GET /v1/status` reports
`memory.holdout_pct` and, once either group has a session, `memory.served` and
`memory.withheld` — each `{sessions, reached, median_min, median_calls}`: how
many reached a first `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, and the median
minutes from `started_at` and `tool.pre` calls before it. Why: on the owner's
database a session continuing yesterday's work took as long to its first edit
as one starting cold (17 vs 16 minutes, 24 vs 23 tool calls; 18 and 19
sessions), with the handoff already on for most of them — so whether it helps
is an open question, and only a control group answers it. The default is 0
because a holdout makes one session in four worse on purpose, which nobody
should get without asking.

### Cross-site request protection

**Binding to loopback is not an authentication boundary against a browser.** Any page the user visits while the daemon runs can send requests to `127.0.0.1`; the same-origin policy stops that page *reading* the response, but not *sending* the request and not what the request does. `POST /v1/agents` executes a command from its body, so an unguarded forgery is remote code execution from a web page.

Guarding only a *present* cross-site `Origin` — the shape `if o != "" && !isLoopbackOrigin(o)` — is therefore wrong, and was the live defect: browsers omit `Origin` entirely on cross-site **simple requests** (an HTML form POST, or `fetch` with a `text/plain` body), so the check was skipped in exactly the case that mattered. **A missing `Origin` is never trusted for a state-changing method.**

When `--lan` is on, the loopback tests above admit **exactly one further host**: the private address the daemon was told to bind. Not the private range — the rebinding defence exists to stop a name an attacker controls from resolving to an address we answer on, and admitting 192.168/16 would leave that open for every address in it.

Every request under `/v1` passes `checkOrigin` (`internal/api/csrf.go`) before routing. The layers, in order:

- **`Sec-Fetch-Site`** — sent by every current browser and not settable by script, so it is the one signal a forgery cannot fake. `cross-site` or `same-site` is refused on **every** method, reads included: a foreign page must not read the session list either. `same-origin` and `none` (an address-bar navigation or bookmark) are the dashboard itself.
- **`Origin`** — when present it must be loopback. Parsed as a URL rather than prefix-matched: `http://localhost.evil.example` has the right prefix and is not loopback, so the earlier `strings.HasPrefix` form accepted any hostname an attacker registered under a `localhost.` or `127.0.0.1.` label.
- **`Host`** — must name this machine, checked only when the request is browser-shaped (`Origin` or `Sec-Fetch-Site` present). This is the DNS-rebinding case: a hostname the attacker controls, pointed at `127.0.0.1`, is genuinely same-origin with the daemon and passes every check above, but the `Host` header still carries the attacker's name. It is not applied here to non-browser clients, which carry no rebinding risk; a non-browser request over loopback under a name that is not loopback is caught one step earlier, by the gate, as a relayed request that needs a device token (see *Who may connect*).
- **A bearer token, or `Content-Type: application/json`** — required on a state-changing method that carries no browser provenance at all. Either one is sufficient. The per-run token lives in `runtime.json` (mode 0600) and a web page can neither read nor guess it. A JSON content type cannot be set by a cross-site *simple* request: doing so forces a CORS preflight, which this server approves for nothing, so the real request is never sent — while a form POST is limited to the three simple content types and so cannot reach the endpoint at all.

**`POST /v1/paste` takes base64 inside JSON, not a raw body — and that is the security design.** A browser hands over a file's bytes and never a path (there is no path for something copied out of a screenshot tool, and a file dragged from Finder arrives as a name and contents), while Claude Code reads files by path, so the bytes have to become a file. That makes this the one endpoint that writes to disk on a web page's say-so.

`image/png` is a *simple* content type, so a raw upload would have been reachable by any page in the browser without a preflight. Wrapping the bytes in JSON puts the endpoint behind the same forgery guard as everything else, at the cost of a third more bytes. The body is `{name, type, data}`; the file is capped at **10 MB**.

- **What is accepted is decided by the extension of `name`**, from an allow-list (`pasteKinds` in `internal/api/paste.go`): images (png jpg jpeg gif webp), pdf, text and documents (txt md markdown rst rtf html htm xml), office (docx xlsx pptx odt ods), data (csv tsv json jsonl yaml yml toml ini log sql) and source (go py ts tsx js jsx rb rs java kt swift c h cpp hpp cs php sh css diff patch). A browser leaves `type` empty for most of these, so a MIME-only check refused them (until 2026-10-04). When the name carries no allowed extension, `type` is the fallback (png, jpeg, gif, webp, pdf, plain, markdown, csv, json) and its extension is appended: `scan.heic` declared `image/png` is stored as `scan.heic.png`. Anything else is **415** with `{error, detail}`, where `error` names the refused extension and `detail` lists what is accepted. Nothing Windows runs by association (`.exe`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.msi`, `.lnk`, `.hta`, `.scr`) is on the list, and every file is written `0600`.
- **The file keeps its own name, sanitised**: the basename only (either slash is a separator), every run of characters outside `[A-Za-z0-9._ -]` collapsed to one `_`, leading and trailing dots and spaces removed, Windows device names (`CON`, `NUL`, `COM1`…) prefixed with `_`, the stem capped at 80 characters, `file` when nothing is left, and the stored extension always the allow-listed one.
- **Each file gets a directory of its own**: `<data_dir>/paste/<UTC timestamp>-<random hex>/<name>`, created with `Mkdir` (never reused), so two pastes of one name never collide and nothing the caller sent can choose the directory.

Every error is JSON `{error, detail}`. Returns 501 when the daemon has no data directory.

**`WS /v1/agents/{id}/term` speaks two versions.** A client that offers the subprotocol `caprock.term.v2` gets [protocol v2](#terminal-socket-protocol-v2); any other client gets version 1, described in the rest of this paragraph and unchanged for dashboards that predate v2. In version 1, the socket **carries two things, told apart by frame type.** A **binary** frame is what the user typed, written to the PTY byte for byte. A **text** frame is a control message — today only `{"resize":{"cols":N,"rows":N}}`, which resizes the PTY; a non-zero pair is required and anything else is ignored.

Everything on this socket used to be treated as keystrokes, so there was no way to tell the daemon the window had changed size: `Resize` was declared on the interface and called by nothing, and a PTY kept the size it was born with — 120×40 by default — for its whole life. Claude Code lays its menus out to the terminal size, so on any other window it drew an interface for a screen that was not there. Arrow keys moved a selection nobody could see, which is what the first user reported as "only Enter works".

A text frame that is not valid control JSON is still written through as input, so a dashboard that predates this against a newer daemon keeps typing rather than going mute.

**Refusals, and asking why.** The upgrade is refused with **409** `session is not owned by caprock` when this daemon does not hold the session's terminal (its process is gone, or its pty-host died, say with a restart of the background service), and with **501** `spawning unavailable` only when, on top of that, no agent can be started here: a session the daemon holds is served whether or not a new one could be started (a daemon started with a bare `PATH` used to refuse every open terminal). A browser is never told why an upgrade failed — the socket just closes, 1006 — so a **plain `GET` on the same route, without `Upgrade: websocket`, is the terminal's diagnosis**: **204** when the socket would be accepted, otherwise the same refusal with its reason (409, 501, or 403 for a shell asked for from a phone). It starts nothing and subscribes to nothing. A paired device sends its token as `X-Caprock-Device`. The dashboard asks after three sockets in a row closed without opening, at most every 15 s, and shows the answer with what to do; a 409 still standing when asked again 10 s or more later ends the terminal (`ui/src/lib/termv2.ts`; [04-ui.md](04-ui.md) § the terminal's connection).

### Permission mode of a running session

ADR-054. Code: `internal/agents/modeswitch.go`, `internal/daemon/permmode.go`,
`internal/api/permmode.go`, `ui/src/components/PermissionModeChip.tsx`.

```
GET  /v1/sessions/{id}/permission-mode → {session_id, mode, source?, switchable, in_session?, restart?, waiting?}
POST /v1/agents/{id}/permission-mode   {mode, restart?} → the same view, after the switch
```

- **`mode`** is Claude Code's word: `default`, `acceptEdits`, `plan`,
  `bypassPermissions`, `auto`, `dontAsk` (`manual` is accepted on the POST as
  `default`); `""` when nothing says. **`source`**: `screen` (the footer of
  the session's terminal, read now), `hook` (the newest hook payload's
  `permission_mode`), `switch` (a switch Caprock made and saw take), `launch`
  (its command line).
- **`switchable`** is true only for a Claude Code session this daemon started
  and holds (rule 7). Any other session answers what its hooks last said,
  read-only; Codex, OpenCode and the others answer `mode: ""`.
- **`in_session`** are the modes Shift+Tab reaches in this process: default,
  accept edits, plan, bypass when its command line has
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`
  or `--permission-mode bypassPermissions`, and auto (in the cycle only when
  the account has it, which a switch finds out). **`restart`** are the rest:
  bypass when the process cannot reach it, and `dontAsk`.
- **`waiting`** is the message queue's reading of the session (ADR-053):
  `permission` or `question` refuse every switch; `turn` refuses a restart,
  and a Shift+Tab switch whose way passes through bypass.
- **A switch** presses Shift+Tab (`ESC [ Z`) one at a time and reads the
  footer after each (`⏸ manual mode on`, `⏵⏵ accept edits on`, …, at most 5
  presses, 2 s each). Nothing is typed while a permission menu is on the
  screen.
- **A restart** stops the process (SIGTERM, kill after 5 s) and resumes the
  same conversation under its own id (`--resume <id>`) with the new flag —
  `--permission-mode manual` for default, so a `permissions.defaultMode`
  setting does not decide instead — the model it was started with, and the
  terminal's size. A restart into bypass needs the ADR-041 consent.
- **Errors** are `{error, code, mode?}`: 400 for an unknown mode; 409
  `not_owned`, `prompt`, `busy`, `bypass_consent`, `stuck` (the restart did
  not complete); 422 `restart` (the mode is not in this process's cycle),
  `unreachable` (the cycle came round without it), `stuck` (Shift+Tab
  changed nothing), `unsupported` (not Claude Code). `mode` is where the
  session was left. 501 when the daemon has no switcher.
- **Devices.** GET is a read for every paired device; POST is a
  controller's (ADR-034).

### Terminal socket, protocol v2

Every output byte has an offset and every input frame a sequence number, so a reconnect resumes from the last byte the client has, without repainting, and a keystroke resent after a drop is typed once ([21-app.md § Terminal protocol v2](21-app.md#terminal-protocol-v2)). Code: `internal/api/termv2.go`, `internal/termbuf`, `ui/src/lib/termv2.ts`.

- **Negotiation.** The client offers `caprock.term.v2` (beside `caprock.device.<token>` on a paired device; the gate reads the token from the request, and only `caprock.term.v2` is echoed). Query: `?client=<id>` (`[A-Za-z0-9_-]{1,64}`, one per tab, numbers its input) and `?since=<offset>` (decimal, the offset one past the last byte the client has; omitted on a first connect). A malformed `client` or `since` is **400**.
- **Offsets.** Byte `n` of everything the session ever printed has offset `n`. The count lives in the pty-host and survives a daemon restart. A session in a pty-host from before v2 is counted from the daemon's clock in microseconds at reattach, so no offset an earlier daemon handed out falls inside the new range; offsets stay below 2^53 (exact in JavaScript).
- **Hello.** The first frame is text: `{"hello":{"v":2,"offset":N,"reset":bool,"ack":S}}`. `reset:false`: the ring still holds `since`, `offset` equals it, and the bytes after it follow. `reset:true` (a first connect, or a `since` the ring no longer holds or never had): the next binary frame is a **snapshot** — the mode prefix (`ESC[?Nh`/`l` for the DEC private modes in force where the ring starts: cursor keys, cursor, mouse tracking and SGR reports, focus, alternate screen, bracketed paste; `internal/termbuf/modes.go`) plus the ring — which the client draws on a cleared terminal, after which its position is `offset`. `ack` is the last input sequence applied for this `client` (0 when unknown).
- **Output.** Binary frames: an 8-byte big-endian offset of the frame's first byte, then the bytes. The client keeps `offset + length` and drops any byte it already has. The daemon keeps no per-client queue: it reads from the session's ring at the client's position, so the output never waits for a client. A client that falls behind the ring gets `{"reset":{"offset":N}}` and a snapshot; a single write that blocks for 10 s closes the socket, and the client resumes with `since`.
- **Input.** Binary frames: a 4-byte big-endian sequence number, then the bytes. Without `client` they are typed as they come. With it, a sequence at or below the last applied for that client is dropped; the table lives in the pty-host (frame `J`, below) and survives a daemon restart, and a client unheard from for **120 s** is forgotten. A frame that could not be confirmed as typed closes the socket with **1011**; the client resends it on reconnect.
- **Acks.** `{"ack":S}`, the last applied sequence, at most 100 ms after it was applied. The client resends everything above the newest ack (or hello `ack`) after every reconnect.
- **Control from the client** (text): `{"resize":{"cols":N,"rows":N}}`, optionally with `"focus":true` in the same frame; `{"focus":true}`; `{"blur":true}`; `{"ping":t}`, answered `{"pong":t}`. Any other text is ignored — v2 never types a text frame, and a daemon from before `focus` or `blur` ignores the key.
- **Size: the terminal in use wins** (tmux's `latest`; `internal/api/termsize.go`). A session's PTY has one size and may have several terminals attached. The daemon remembers each socket's own size (its last `resize`) and gives the PTY the size of the one **in use**. A socket becomes the one in use when it sends input (any binary frame, before the bytes are typed), when it sends `focus` (the client's window gained focus or came into view, its tab came to the front, a click in the terminal), when it is the only socket with a size, or when its `client` id is the tab that last claimed the PTY (a reconnect of that tab). Every other socket is a **viewer**: its resizes are recorded, not applied, and it is drawn at the size in use. A claim by the socket already in use at the size the PTY already has changes nothing, so a claim on every keystroke costs nothing. A socket says `blur` when its terminal goes out of sight (the page hidden, a phone locked or in the background, an app tab behind another, the page going away); it stays a viewer until its next claim. When the socket in use sends `blur`, the PTY goes at once to the socket in sight that claimed most recently, at its last size, and that socket's `client` becomes the owner, so a phone whose socket died while locked does not take the PTY back by reconnecting; with no other socket in sight that has a size, nothing changes. When the socket in use closes, the PTY goes to another socket of the same `client`, else to the one that claimed most recently, a socket in sight before one out of sight, at its size. A client re-sends its current size with every `focus` (`{"resize":…,"focus":true}`), so a PTY left at another terminal's size by a close the daemon never saw is put right by looking. Before 2026-10-13 there was no `blur`: a phone put away kept the PTY until its socket was taken for dead (25–35 s when its page froze, never when its browser kept answering pings in the background), and the desktop stayed at the phone's width (Vova). Until 2026-10-12 every resize was applied and the last sender won: a phone that typed into a session left the desktop's agent drawn 45 columns wide in a wide pane until the desktop's box next changed (Vova).
- **Repaint.** A socket's **first** resize repaints: the PTY is given one column less, then the full size once the program has written output after the narrower one (up to 750 ms for one that draws nothing on a resize, `repaintWait`) and at least 40 ms after that (`repaintGap`) — two real size changes, so whatever runs gets SIGWINCH and redraws its whole screen — at the new socket's size when it is in use, at the size in use when it is a viewer (a phone opening a session never shrinks the desktop's agent). Without it a reattached terminal kept the ring's replay, and a TUI that redraws by difference (Claude Code) showed rows whose labels had scrolled out of the ring as bare numbers until something changed size. A column, not a row (since 0.140.2): on one row less Claude Code clears only as many rows as it then thinks it has, so the terminal's bottom row kept a stale line after every attach and resume; a width change clears every row. It waits for output because a fixed 40 ms was not enough (owner, 2026-10-21, on a loaded Mac): two SIGWINCHes that arrive while a program's event loop is busy reach it as one, at the size it already drew at, so it redrew nothing and the replay's bare changed cells stayed — a status line of lone digits, the mode line's words gone. A Node program blocked 120 ms in every 150 saw no resize at all on 2 of 5 such repaints. A client sent `reset` and a snapshot mid-session (it fell behind the ring) gets the same repaint at the size in use. The PTY passing from one terminal to another repaints the same way; the socket in use resizing its own box is applied as sent. Version 1 sockets resize as before (every resize applied).
- **Liveness.** Each side sends `{"ping":t}` every 10 s and answers the other's with `{"pong":t}`; 25 s with nothing received closes the socket.
- **End.** When the process exits: the last output, `{"exit":{"code":N}}`, then close **1000**. When it exits to be resumed under the same id in another permission mode (`POST /v1/agents/{id}/permission-mode` with `restart`), the frame is `{"exit":{"code":N,"restart":1}}`: the client keeps the tab, forgets its offset (the new process has a new ring) and reconnects through the 1000 close, retrying while the daemon answers 501 until the new process is up. Close **1008**: the device lost the controller role, do not reconnect. Any other close is the connection, and the client reconnects by the policy `/v1/live` shares (§ Client reconnect policy, below).
- **Client backpressure.** The dashboard closes the socket while more than 1 MiB it has received waits for xterm.js to parse, and reconnects with `since` once that drops to 256 KiB.

### Live socket, replay

Every `/v1/live` frame carries a `seq`, so a client that reconnects gets exactly the frames it missed, or is told to refetch ([21-app.md § Phase A](21-app.md#phase-a--resilience-and-starting-work-p0), WP-12). It mirrors [protocol v2](#terminal-socket-protocol-v2) with frames in the `{type, seq, data}` envelope. Code: `internal/bus` (numbering and the ring), `internal/api/ws.go`, `ui/src/lib/live.ts`.

- **Seq.** One counter per daemon, raised by one for every frame published (`event`, `event_update`, `session`, `alert`, `permission`, `queue`, `task`, `project`, `op`, WP-09's `notify`, and the resource meter's `resources`, § Resources). It starts at the daemon's start time in microseconds, so a seq handed out by an earlier daemon is never inside a later one's range, and stays below 2^53 (exact in JavaScript). Clients compare seqs only for order within one daemon.
- **Ring.** The daemon keeps the last **2,000 frames or 10 minutes**, whichever is fewer.
- **Resume.** Query `?since=<seq>`, the seq of the last frame the client applied (decimal; malformed is **400**). Omitted on a first connect, and by every client that predates replay: those get the stream as before, each frame now also carrying `seq`, which they ignore.
- **Hello.** The first frame is `{type:"hello", seq, data:{server_time, reset}}`. `reset:false` with a `since`: `seq` equals it, and the frames after it follow, in order, then the live stream with no gap and no duplicate. `reset:true` (the ring no longer holds `since`, or never did — another daemon, a seq from the future): `seq` is the newest frame and `{type:"reset", seq, data:{seq}}` follows; the client refetches what it shows and continues from `seq`. Without `since`, `reset` is false and `seq` is the newest frame.
- **Falling behind.** A socket whose per-client buffer (1,024 frames) overflowed is caught up from the ring at once, or sent a `reset` when the ring no longer reaches back far enough; it never stalls the publisher or another client.
- **Liveness.** The daemon sends `{type:"ping", seq, data:t}` every 10 s, and answers a client's `{"ping":t}` with `{type:"pong", seq, data:t}`; the client answers the daemon's ping with `{"pong":t}`. A ping or pong's `seq` is the client's position, not a new frame. Either side takes 25 s with nothing received for a dead socket and closes it (the daemon also counts a WebSocket protocol pong, which every browser sends by itself, so a client that predates the ping frame is not cut off); the client reconnects with `since`.
- **Client.** `ui/src/lib/live.ts` drops a frame whose seq is not above the last applied (a hello or reset sets the position outright), bumps the refetch tick on `reset`, and keeps the `notify` frames it received, newest first and one per `id`, for WP-09 to show.

### Client reconnect policy

One policy for both sockets, `ui/src/lib/reconnect.ts` (WP-13, [21-app.md § Phase A](21-app.md#phase-a--resilience-and-starting-work-p0)). Client-side only: no frame or endpoint changed.

- **Forever, with full jitter.** Retry `n` (from 0) waits a uniform delay between 0.5 s and `min(15 s, 0.5 s × 2^n)`; there is no last attempt. The count and the delay reset when the link is live again: the `hello` on either socket (on a version 1 terminal socket, the open).
- **At once** on `visibilitychange` to visible, `online`, the window's `focus`, `pageshow` and `navigator.connection`'s `change` (where the browser has it). An open socket heard from in the last 12 s is pinged and must answer within **2 s**, or it is replaced at once; one silent longer is replaced without asking. If the page wakes while an attempt is still opening, that attempt is given its chance and, should it fail, the next starts with no delay.
- **Dead.** Nothing received for 24 s (checked every second, so a half-open socket is caught within the 25 s deadline), or an attempt not open after **10 s**, closes the socket and counts as a failure.
- **Watched between sockets.** The once-a-second check runs with no socket too, from the first connect until the client ends, is disposed or (a terminal) is let go out of sight: with no retry scheduled — an attempt whose `WebSocket` constructor threw, a timer lost — one is scheduled, and a retry overdue by more than **3 s** (a timer the page held back) runs at once. A terminal paused for its own backlog (Client backpressure) whose xterm.js has reported nothing parsed for **15 s** resumes anyway, from the offset it reached. Before this (2026-10-15) one thrown constructor ended the retries for good, and the terminal said *Reconnecting…* until its tab was closed.
- **By hand.** After **3** failed attempts or **10 s** down, the state offers **Reconnect now**: an attempt at once, whatever the backoff, the pause or a let-go tab was waiting for. It resumes the same session from the last byte, as any reconnect; no process is started.
- **Not retried.** Terminal close 1000 (the process exited) and 1008 (the device lost the controller role; the close reason, or "ask on the machine Caprock runs on", is shown). Close 1011 is retried, and the input it names is resent after the `hello`.

### Notify frame

`{type:"notify", seq, data:{id, kind, session_id, project?, title, body, prompt_id?, actions?, route?}}` — an alert for the desktop app (kind `module`, with an empty `session_id`, is a private module's `POST /v1/x/<id>/notify` — `id` `module-<id>-<ns>`, `title` `<module name> · <title>`, `body` the module's, `route` `#/x/<id>`, which a click opens: the `notify` command's `route`, kept only when it is `#/x/<module id>`, then `caprock:open-route` on macOS and Linux, the app coming forward elsewhere; published only while `notify_approval` or `notify_finished` is on, § Private modules; kinds `ci` and `review`, with an empty `session_id`, come from GitHub, § GitHub; kind `window`, also with an empty `session_id`, is the plan-window stop pausing or resuming sessions — `id` `window-paused-<ms>` or `window-resumed-<ms>`, `title` `Paused 2 sessions · Claude's 5-hour limit at 91%` or `Resumed 2 sessions · Claude's plan window reset`, `body` one session per line (project · title) and, for a pause, `They resume after it resets at 19:00.`; published whenever the stop acts, not behind a notify switch) (WP-09, [21-app.md § Notifications](21-app.md#notifications)). Code: `internal/alerts` (`Notify`), `internal/daemon/phonealerts.go`, `ui/src/lib/notify.ts`, `app/src-tauri/src/notify.rs`, `app/src-tauri/src/notify_macos.rs`.

- **One decision, two senders.** The alert rules (below, § Phone alerts) run once over the stored events; a kind is decided while Telegram's switch or the app's is on, and the 3-minute per-session cooldown and the 20-an-hour cap count each decision once for both. Each sender then delivers it only if its own switch is on. `PUT /v1/settings` takes `notify_approval` (on unless turned off; every "Needs you": a dialog, and since 2026-10-21 a turn that ended on a question or an error) and `notify_finished` (accepted and returned, no longer read: a Done turn raises no notification, § Needs you and Done), stored as pointers in `config.json`; `GET` returns both. Telegram's `alert_*` switches are untouched and stay off unless turned on.
- **Fields.** `id` is `<alert kind>-<session_id>-<trigger ms>`, unique per alert and the same on a replay. `kind`: `approval`, `finished`, `question` for a turn whose last message asks something (§ Needs you and Done), or `error` for a turn that ended on a StopFailure. `project` is the session's project, else its folder's name. `title` is plain text, `Needs approval · <project>` (`Needs your answer`, `Finished`, `Queued message done` — § Queue —, `Stopped: <error>`); `body` is lines of plain text: the session's name, branch and a non-Claude agent (left out when it would only repeat the project), then for a dialog the tool and its command, file, URL or question (100 characters), for a finished run its duration, cost, tool calls, changed files and — while `alert_reply` is on — the reply's first line; the twentieth of an hour adds that the rest wait. Nothing is HTML-escaped; the frame never leaves the machine except to a paired dashboard, which already sees the same tool inputs on `event` frames.
- **Prompt and actions.** For an approval in an owned Claude Code session waiting on exactly one ADR-035 prompt, `prompt_id` is that prompt's `id`; with two or more outstanding neither field is set, since which dialog the terminal shows is unknown (amended 2026-10-09). A subagent's request says so in the body: `Subagent (general-purpose) · Bash: …`. With one, `actions` lists `choice` values of `POST /v1/agents/{id}/permission`, which answers only while that prompt waits (409 otherwise): `["allow","deny"]` when the body shows the whole request (the command, file, URL or query on one line, not clipped), else `["deny"]` — a notification does not approve what it did not show; the prompt card does. `always` is never offered. The hook sets the prompt before the event is stored, so it is there when the alert is decided. No prompt (a session Caprock did not start, another agent, AskUserQuestion's menu): neither field.
- **The app.** In the Tauri shell only, `ui/src/lib/notify.ts` shows each new `id` once through the `notify` command (`{title, body, id, sessionId, promptId, actions, route}`; a shell that predates the last five ignores them), unless the window has focus and that session is in front, or an approval's prompt (checked with `GET /v1/agents/{id}/permission`) no longer waits. On macOS, in the app bundle, the shell shows it through UNUserNotificationCenter: `["allow","deny"]` becomes **Approve** and **Deny**, `["deny"]` becomes **Open in Caprock** and **Deny**. The shell answers a button itself, from Rust, with `POST /v1/agents/{session_id}/permission` `{id: prompt_id, choice}` to the loopback daemon it is attached to (the supervisor's connected port; never another host), without bringing the window forward; a 409 is followed by an "Already answered" notification, any other failure by "Could not answer" with the reason, and a click on either opens the session. A click on a notification's body, or Open, brings the window up and opens the session as the tray does (`caprock:shown`, then `caprock:open-session`). When a `permission` frame says a session no longer waits, the page withdraws the approval notifications it showed for that session with `withdraw_notifications` (`{ids}`, the notify ids; macOS removes them from Notification Center, other OSes ignore it). Elsewhere the official notification plugin shows a title and body and reports neither clicks nor actions, so Approve and Deny are the prompt card's buttons: the app coming forward within 2 minutes of a notification it showed while in the background opens `#/session/<id>?tab=terminal` (the session's tab, its prompt card in view), unless the prompt was answered meanwhile or the shell brought the window up itself: the menu bar, tray and hotkey (WP-10) dispatch `caprock:shown` before showing it, and the open waits 300 ms for that event and drops the notification when it comes. A browser tab shows no notification of its own.

`GET`/`HEAD`/`OPTIONS` are otherwise permissive because every `GET` route on the router is a query. The two that reach a live process — `WS /v1/live` and `WS /v1/agents/{id}/term` — are WebSocket upgrades guarded by coder/websocket's `OriginPatterns`, which already refuses a missing or foreign `Origin`. **A new `GET` with a side effect belongs behind a `POST`**, not on the safe-method list.

Non-browser clients are unaffected, and each in-repo client was checked against its real request shape: the hook shim and `caprock statusline` send JSON + a bearer token, `caprock down` sends a bearer token with no body, `caprock task create` sends JSON, and `caprock tasks`/`status` are plain reads. The dashboard's single mutation helper (`ui/src/lib/api.ts`) already sets `Content-Type: application/json`. `curl` with `-H 'Content-Type: application/json'` works as documented.

### Phase 0

```
GET  /v1/sessions?active=true          → SessionSummary[]
GET  /v1/sessions?dir=<path>           → SessionSummary[] — one Projects row's sessions, each with `resume`
GET  /v1/sessions/{id}                 → SessionDetail (stats + last N events)
GET  /v1/sessions/{id}/relay           → RelayBrief (the proposed first message for a relay)
GET  /v1/sessions/{id}/events?after=…  → Event[] (paginated; newest=1 returns the tail; with newest=1, main=1 keeps the main thread only and kind=a,b those kinds, both before the limit)
GET  /v1/sessions/{id}/subagents       → {working: SubagentNow[], finished} — the subagents working in it now (§ Subagents now)
GET  /v1/sessions/{id}/subagents/{agent} → SubagentDetail — one subagent opened: task, calls, result, numbers (§ One subagent)
GET  /v1/sessions/{id}/calls?limit=…   → SessionCall[] — every priced main-thread model call, oldest first (§ Session calls)
GET  /v1/sessions/{id}/notes           → AssistantNote[] — what Claude said, newest first
GET  /v1/sessions/{id}/todos           → SessionTodos — the agent's own task list (§ Session todos)
GET  /v1/sessions/{id}/prs             → {connected, prs: SessionPRLive[], fetched_at, refreshing?} — the session deck's PRs with CI
POST /v1/sessions/{id}/prs/{number}/rerun → {ok, mode, runs, jobs} — re-run one of the session's PRs' checks on GitHub (machine only)
POST /v1/sessions/{id}/prs/{number}/update-branch → {ok} — merge the base into one of the session's open PRs on GitHub (machine only)
GET  /v1/sessions/{id}/ci              → SessionCI — the deck's CI cell: Actions runs, jobs, steps, times
GET  /v1/sessions/{id}/ci/jobs/{job}/log → CILog — the lines around a failed job's error, on demand (?view=pr|release|main)
GET  /v1/sessions/{id}/ci/release      → SessionRepoCI — the repository's newest release build, with an estimate
GET  /v1/sessions/{id}/ci/main         → SessionRepoCI — the newest run of each workflow on the default branch
GET  /v1/sessions/{id}/ci/stats        → SessionCIStats — the Pipeline: the repository's PRs and its figures over 14 days
GET  /v1/sessions/{id}/branches        → SessionBranches — the repository's branches with PRs and Caprock spend (§ Session branches)
GET  /v1/repos/activity                → ReposActivity — Now's Repos section: each listed repository with a live session, from git and kept GitHub answers
GET  /v1/repos/ci                      → ReposCI — Now's CI/CD section: runs, stuck runs, releases, cost per PR and who, GitHub's status
GET  /v1/repos/remotes?dir=…&dir=…     → ReposRemotes — the Pipeline's picker: which folders are git repositories on GitHub
GET  /v1/notes?q=…&before=…            → AssistantNote[] — search that prose across sessions, paged
GET  /v1/sessions/{id}/diff            → { files: FileDiff[] } | 409 not-a-git-repo — a shell tab's id gives its folder's diff (machine only; 403 to a paired device)
GET  /v1/stats/summary?range=today     → totals: tokens, cost, sessions, models
GET  /v1/stats/limits                  → {rate_limits?, codex_rate_limits?} — the plan windows alone, as the summary carries them
GET  /v1/settings                      → user-stated settings (plan, update checks)
PUT  /v1/settings                      → store them
PUT  /v1/tabs                          {viewer, sessions} → 204: the sessions this dashboard has a tab for, in strip order (§ Open tabs)
GET  /v1/tabs                          → TabsAnswer {known, at, sessions, items}: the computer's tabs the phone home mirrors (§ Open tabs)
POST /v1/offer                         → {status: "sent"} — forward one offer-survey answer to caprock.dev on the user's click (§ Offer survey, ADR-062)
POST /v1/support                       → {ok: true} — forward one bug report to Caprock support at caprock.dev on the user's click (§ Report a bug, ADR-073)
GET  /v1/update                        → cached release status (no network I/O)
POST /v1/update/check                  → check now (403 unless enabled); ?soon=1 → only if the last check is 10+ min old
GET  /v1/update/busy                   → {working} — sessions an app restart would interrupt (Update automatically, ADR-042)
POST /v1/hooks/install                 → {hooks: HooksStatus, backup?} — `caprock hooks install`, from the dashboard
POST /v1/claude/bypass-consent         → {accepted: true} — the user accepted Caprock's copy of Claude Code's bypass warning (ADR-041)
GET  /v1/stats/daily?days=30           → DailyStat[]
GET  /v1/stats/trends?agent=…         → Trends — Now's Today cells: 14 previous days cut at this time of day, today, the usual burn
GET  /v1/pipeline/agents?repo=…      → RepoAgents — the Pipeline's cost per agent-hour and agent team for a repository's folders (§ Pipeline agents)
POST /v1/hook                          → 204 (shim only, bearer-token gated; the event is written even after the shim hangs up)
WS   /v1/live                          → server-push frames: {type:"event"|"session"|"alert", data:…}
```

### The Week (`GET /v1/week`)

```
GET  /v1/week?start=YYYY-MM-DD          → Week — seven local days from `start`; omitted, the seven days ending today
GET  /v1/week?period=today|7d|30d|all   → Week — the same card for a named window, in whole local days ending today
```

`period` names the share dialog's windows: `today`, `7d` (the default
window), `30d` (the last 30 local days, as the Cost screen's 30d range) and
`all` (from the local day of the first recorded event). The response carries
`period`, `days[]` has one entry per day of the window, and every other field
means what it means for a week. `period` and `start` together, or an unknown
period, is `400`. Long windows are cached for 2 minutes instead of 30 s: on
a copy of the owner's 1 GB database (2026-10-04) `all` takes about 11 s
cold, `30d` about 3 s, `7d` 1.5 s and `today` 0.3 s. The two payload readers
(tool calls and the loop replay) run beside the rest, and the replay skips the
detector's read-only tools in SQL rather than after reading them. Each reader
also cuts the window into slices of about equal event counts (four for the
replay, two for tool calls) read side by side and joined back in time order,
so the figures are those of a single pass: `all` went from 5.0 s to 1.9 s on
a warm copy of the 1.2 GB database (2026-10-05). They are not computed at
start any more: `Server.Warm` did, and the slow-query log named those payload
scans as the startup's biggest reads on the owner's 2.2 GB database
(2026-10-13) — a gigabyte-scale read on every start for a dialog most starts
never open. The dialog pays for its period once, when it is opened.

The Week screen's shareable card. `start` is a local date and the window is
`[start 00:00, start+7 00:00)` in the daemon's time zone: the same days the
Cost screen's `7d` range uses, so the two never disagree about which day a
turn fell on. A `start` that is not `YYYY-MM-DD` is `400`.

`{start, end, partial, from_ms, to_ms, days[], sessions, active_days, turns,
cost_usd, unpriced_turns?, models[], prs_opened, prs_merged,
merges_unresolved, commits, files_edited, lines_added, lines_removed,
ci_wait_ms, tool_ms, agents[], loop?, biggest?, tax?, subagent_saving?, cost_per_merged_pr?,
estimates[], pricing_version?}`. `days[]` is `{day, prs_opened, cost_usd,
active}` × 7; `agents[]` is `{agent, subagent, turns, cost_usd, sessions,
threads?}`; `loop` is `{agent, tool, kind, calls, first_ms, last_ms, tax_usd?,
tax_priced_calls?}`; `biggest` is `{agent, cost_usd, turns, active_days}`.

Everything is computed from the local database (`store.WeekStats`); the daemon
asks nothing of GitHub, so what can be said is bounded by what the agents'
own tool calls recorded:

- **Opened** is distinct `github.com/<owner>/<repo>/pull/<n>` URLs printed by
  a successful Bash call that ran `gh pr create`, minus lines saying the pull
  request already exists. Success is a hook-plane `PostToolUse` that was not
  interrupted, or a transcript-plane `tool.post` with `is_error` false.
- **Merged** is distinct pull requests named by a successful `gh pr merge`: by
  URL, by number (made distinct by the repository the command ran in, mapped
  to `owner/repo` through the URLs `gh pr create` printed there), or — for the
  current-branch form — by the one URL the command printed. A merge whose
  target cannot be read (`$N`, a branch name, several URLs) is counted in
  `merges_unresolved` and nowhere else. It is a merge the agents ran, not
  GitHub's state.
- **Commits** are `git commit` statements, read with a small shell splitter
  (quotes, heredoc bodies, `cd`, `-C`) so a commit message mentioning a commit
  is not one; output saying "nothing to commit" takes one off.
- **Files and lines** come from successful Edit, Write and MultiEdit calls
  outside temp directories and `~/.claude`. Lines are estimates: a Write
  counts its whole file.
- **Cost** is the stored `cost_usd`, priced once per message id and never
  twice across forks; `tax` prices each model's cache reads exactly as
  `/v1/history` does. `cost_per_merged_pr` divides all of the week's cost by
  the merges — an estimate, absent when nothing merged.
- **CI wait** is the hook-plane `duration_ms` of Bash calls whose statement is
  `gh pr checks`, `gh run watch`, or a script named like `wait-ci`. Tool time,
  not wall clock: parallel calls overlap.
- **The loop** is the longest episode the live detector would have alerted on
  — `loop.Signature`, read-only tools and browser observation steps skipped
  (`loop.Ignored`), at least `loop_k` calls within
  `loop_t_minutes`, the episode running while repeats keep arriving within the
  window — except that repeats issued by one assistant message count once (a
  turn that launches eleven subagents decided once). `tax_usd` is priced by
  `contexttax.PriceSeries`, the function the live alert uses, and is absent
  when no call could be priced (Codex calls carry no message id).

**Nothing in the response names a repository, a path, a prompt or a session
title.** The card is made to be posted, so the guard is in the shape of the
payload rather than in the screen that draws it; a store test asserts it.

- **Subagent saving** (`subagent_saving: {models[], cost_usd, haiku_usd,
  haiku}`): the window's Claude Code subagent tokens (priced turns of
  non-internal subagent events, `store.SubagentTokensByModel`) on every model
  that costs more than the newest current Haiku row of the pricing table,
  priced at that row's rates and then at Haiku's, token type by type. Absent
  without a pricing table or a Haiku row, when no subagent ran on a pricier
  model, and when the difference is under a dollar. An estimate at list prices
  (the same tokens, which Haiku would not necessarily use); the Haiku 5.5 row
  carries its lower prompt-length tier, so a long prompt is under-priced on it.

`estimates[]` lists the fields a renderer must mark with "≈"
(`lines_added`, `lines_removed`, and `cost_per_merged_pr` / `loop.tax_usd` /
`subagent_saving` when present). Responses are cached for 30 s per `start`.

### Activity (`GET /v1/activity`)

Each session's turns and tool calls (`turn.assistant`, `tool.pre`; internal
events left out) over the last hour, in 30 buckets of two minutes, oldest
first, aligned to the bucket so a poll a minute later moves whole bars. A
session with nothing in the hour is absent. One range scan on
`idx_events_ts`; the sidebar sums a project's sessions into its sparkline.

```json
{ "from": 1791730800000, "bucket_ms": 120000, "buckets": 30, "sessions": { "<session_id>": [0, 2, 5, 0, …] } }
```

### At a glance (`GET /v1/glance`)

```
GET  /v1/glance                         → Glance — all-time split by agent and the bill by token type
GET  /v1/glance?range=today|7d|30d|all  → the same, over one range (the share card's agent mix)
```

`{agents[], bill?, display, trend?}` for the Now screen's At a glance block, all time
and never filtered by agent. `range` takes the summary's ranges (local
midnight today, the last 7 or 30 days, all) and is how the share card draws
the agents of the period it is about; absent or `all`, all time:

- **`agents[]`** is the same shape as the Week's (`store.AgentSplit`, which
  the Week now calls too): turns and stored `cost_usd` per agent, Claude
  Code's split into main threads and subagents (`threads` = distinct agent
  ids). A turn is a subagent's when it carries an `agent_id`, or when its
  session is a sidechain (OpenCode child sessions, whose every turn says so).
  The split reads `idx_events_turn_agent` (migration 0031) and one payload per
  session rather than one per turn.
- **`bill`** is `{input_usd, output_usd, cache_write_usd, cache_read_usd,
  unpriced_tokens}`: each model's summed tokens priced at its **current**
  pricing-table rates, the way the context tax is, so the four add up to
  roughly — not exactly — the stored cost, which priced each turn at the rate
  of its day. Cache writes are split into the 5-minute and 1-hour rates.
  Tokens of a model with no row are counted in `unpriced_tokens` and priced
  nowhere. Absent with no pricing table.
- **`display`** maps each model id seen to the table's display name.
- **`trend`** (all-time answer only; absent with `range`) is two equal
  windows ending now, for the block's change-in-share markers:
  `{days, prior_from_ms, cut_ms, to_ms, prior, recent}` with `days` = 7,
  prior = `[prior_from_ms, cut_ms)` and recent = `[cut_ms, to_ms)`. Each
  window is `{models, bill?, tools, agents}`: `models` maps model id to
  stored `cost_usd`, `bill` is the shape above priced the same way, `tools`
  maps tool name to `tool.pre` calls (the calls Most-used tools counts), and
  `agents` is `store.AgentSplit` over the window. The turns and the tool
  calls are one grouped query each, the window a `GROUP BY` column
  (`store.TrendWindows`, on `idx_events_turn_agent` and
  `idx_events_tool_dist`, both covering; the plan guard checks it).

Cached for 60 s per range and range start; on the owner's 1 GB database
(2026-10-04) a cold all-time build takes 0.44 s.

`SessionSummary` gained `model_display` (the table's name for the session's
model, "Claude " dropped) and `live_subagents` — for a session that has not
ended, the agent ids heard from in the last 30 minutes whose latest event is
not their `agent.stop`. Claude Code reports no subagent start, only events from
inside it and a stop, so a subagent whose stop never arrived stops counting
after 30 silent minutes. Both are omitted when empty or zero.

**A turn that ended with subagents still working is not waiting on anyone.**
When the main thread's newest event is a top-level `agent.stop` and
`live_subagents` is above zero, `activity` reads `health: "working"`, `phrase:
"background agents working · N"` and `background: N` (omitted otherwise):
Claude Code resumes the parent by itself when its background subagents finish.
A `permission.prompt` as the newest event still reads `waiting-on-you`, and
looping and ended outrank it. Without it the owner's cockpit said "Waiting on
you" beside "1 subagent working" (2026-10-09). The project list's `waiting`
count, the sidebar's waiting rows, ⌘J and the "finished" alert (`internal/alerts`,
held until the last subagent stops and a minute after) follow the same rule.

### Needs you and Done

**A turn that ended is either Needs you or Done** (owner, 2026-10-21;
[04-ui.md § Needs you and Done](04-ui.md#needs-you-and-done)). Before, every
main-thread `agent.stop` read `waiting-on-you`, also when the last message
said the work was finished. `activity.health` now has a seventh value, `done`,
and `activity.need` (`narrate.Need`, omitted unless health is
`waiting-on-you` or `done`) says why: `{reason, detail?, text?, guess?,
moved?}`. The rules, first match wins (`internal/narrate/need.go`):

- **`permission`** — a newest `permission.prompt` whose tool is neither
  `AskUserQuestion` nor `ExitPlanMode`. Certain.
- **`question`** — the same prompt for `AskUserQuestion` (*waiting for your
  answer*). Certain.
- **`plan`** — the same prompt for `ExitPlanMode`; the phrase is *plan to
  approve*. Certain.
- **`error`** — a newest main-thread `throttle` (StopFailure), or a Stop
  whose turn (after its prompt, with no tool call in between) holds one;
  `detail` is why, `rate limit` from `rate_limit`, and the phrase *stopped:
  rate limit*. Certain. It read *working*, then *idle*. A subagent's
  StopFailure stays *working*.
- **`asks`** — a normal Stop whose `last_assistant_message` (fenced code
  left out) ends with `?` in one of its last three non-empty lines, has a
  question inside its last line followed by more text, ends on two or more
  options introduced by a line offering a choice (`Options:`) or lettered
  `a)`/`b)`, or says *should I*, *shall I*, *do you want*, *would you
  like*, *want me to*, *let me know*, *tell me*, *your call*, *up to you*,
  *over to you*, *your decision*, *need your*, *waiting for your* or a
  sentence opening with *which* in those lines. `guess: true`; `detail` is
  `choice` for an either/or or options, else `question`; `text` is the line
  it rests on (200 characters). Health `waiting-on-you`.
- **`done`** — any other Stop, an empty or missing message included.
  `guess: true`, `text` the last line. Health `done`, phrase *done*.

Measured on the owner's 4,133 main-thread Stops (2026-08-19 to 2026-10-21,
every one carrying `last_assistant_message`): 16% read `asks`. A
hand-labelled sample of 40 (20 of each) found 19 of 20 `asks` right (the
miss: a reply Claude drafted for a third party, ending in that person's
question) and 16 of 20 `done` right (the misses: step-by-step instructions
for the owner to carry out, and "waiting for what you say" in words the
English phrase list does not hold). A failed tool call before a Stop is read
through the message: no Stop in the sample lacked one.

Background subagents still turn either state into `working`; looping and
ended outrank both; a submit nudge reads `done` as it reads `waiting-on-you`;
a rejected dialog reads `waiting-on-you` with `reason: asks` (Claude Code
asks what to do instead), not a guess. Codex, OpenCode and the other agents
record no Stop and read as before. The project list's `waiting` count
counts `asks` and `error`, not `done`.

**The owner's correction.** `PUT /v1/sessions/{id}/needs {needs: bool}`
moves the turn that ended last: `true` (*needs me?*) turns a guessed `done`
into `waiting-on-you`, `reason: asks`, `moved: true`; `false` (*not needed*)
turns a guessed `asks` into `done`, `moved: true`. A certain reason is never
moved. 400 without `needs`, 404 for an unknown session, 409 while the
session's newest main-thread event is not a Stop. Stored in the daemon's
memory only (`api.needMoves`), one per session, naming the Stop it was made
at, so the next turn reads afresh with nothing cleared; a daemon restart
forgets it and the turn reads as guessed. A `session` frame follows so every
screen reads it. A controller may make it (a mark in memory; it types
nothing).

**Notifications.** A finished alert carries the turn's need
(`alerts.Alert.Need`). The desktop app's notify frame is never sent for a
`done` turn; a turn that ended on `asks` is `kind: "question"`, titled
`Needs your answer · <project>`, and goes under `notify_approval` with the
dialogs; `notify_finished` is no longer read. Telegram titles an `asks` turn
`❓ Needs your answer` and still sends a `done` turn as `✅ Finished` while
`alert_done` (on unless turned off) and `alert_finished` are on. A kind the
senders do not want for that need spends no cooldown and no hourly slot.

### Nudges

**Input typed into a session Caprock started moves its status before the
session writes an event for it** (2026-10-14). Every key and button reaches
such a session through the daemon (`agents.Manager.Input`, `InputSeq`,
`AnswerPermission` — the terminal, the composer and queue, the card, the
phone, Telegram), which keeps each session's newest *nudge*
(`narrate.Nudge`, in memory, gone with the session): what was typed and
when. `activity` reads it only while it is newer than the session's newest
event, so the next event always wins:

- **`approved`** — a permission dialog answered with an option that runs the
  call: a button's *allow* or *always*, or a digit or Enter in the terminal
  whose option (read off the screen as the buttons read it, the marked one
  for Enter) is not a "No". Over a newest `permission.prompt` it reads
  `health: "working"`, `phrase: "approved — <the call>"`. A dialog writes
  nothing when it is answered; without this the session read *waiting for
  approval* until the call's `PostToolUse`, the whole run of a build.
- **`rejected`** — the *deny* button, a "No" option, or Esc or Ctrl+C with a
  dialog up: over a newest `permission.prompt`, `waiting-on-you`, *waiting
  for you* — Claude Code drops the call and returns to its prompt.
- **`submit`** — Enter (a typed `\r`, not ESC CR) with no dialog up. For 5 s
  (`narrate.NudgeWindow`) a session that read `waiting-on-you` (its turn
  ended) or `idle` reads `working`, *starting on your message*, with
  `activity.provisional: true`; then, with no event behind it, what the
  events say again. A prompt Claude Code accepts fires `UserPromptSubmit`
  within milliseconds; Enter that submitted nothing is not work.

A dialog for `AskUserQuestion` is answered by its own call's hook and is
left alone; looping, error and ended outrank a nudge; with two or more
dialogs outstanding a key answers one Caprock cannot name and nudges
nothing. A session Caprock did not start has no nudge (rule 7: nothing
here sees its keys). An approval older than the idle window reads idle
(*was approved — …*), as a call does; a session row marked `idle` by the
sweep does not turn a nudged *working* back to idle.

Each nudge is published as a `status` frame on `/v1/live`,
`{session_id, kind, at}` (unix ms), and a `submit` once more when its 5 s
are up, so every screen reads the session again at once (04-ui.md § A
status moves at once). After a `submit` into an owned Codex or Gemini
session the daemon reads their transcripts or telemetry at 0.3, 1.2 and
3 s instead of waiting for the poll (Codex every 5 s, Gemini every 3).

`GET /v1/status` gained `platform` (`GOOS/GOARCH`) — the first thing a bug report needs and the last thing anyone remembers to include.

The dashboard route `#/session/{id}?at=<unix-ms>` reveals a moment in the timeline (used by the pulse); it is a client-side concern and needs no endpoint.

**`?before=<id>` pages by `(ts, id)`**, the same key the page is ordered by: rows sharing the cursor row's millisecond with a lower id are included. With `ts <` alone they were skipped at a page boundary, and the chat view (WP-14) lost the tool call made in the same millisecond as its turn.

**`GET /v1/sessions/{id}/events?newest=1` returns the tail rather than the head**, oldest-first within the page. Paging from the start is right for a timeline read forwards and wrong for anything showing recent activity: on a session with thousands of events, `after=0` hands back the first few hundred — hours old — so a caller asking "what just happened" renders an empty window with no indication why.

**With `newest=1`, `main=1` and `kind=a,b,…` filter before the limit.** `main=1` keeps the main thread's events only (`agent_id` empty and `payload.sidechain` not true, the rule notes use); `kind` keeps the listed kinds. The agent cockpit asks for `main=1&kind=tool.pre,tool.post,turn.assistant&limit=400`: on the owner's 36-hour session (2026-10-09) the newest 400 events were all subagents' — 635 of their tool calls in the last hour — and its tool list read *No tool calls yet* over 4,933 calls. The filtered page walks `idx_events_session_ts` and took under 60 ms there. Without `newest=1` both are ignored.

**Subagents now.** `GET /v1/sessions/{id}/subagents` → `{working, finished}`. `working` lists the subagents working in the session under the rule `live_subagents` counts by — an `agent_id` heard from in the last 30 minutes whose newest event is not its `SubagentStop` — newest activity first, at most 24 (the cockpit draws two rows of twelve chips), each `SubagentNow`: `agent_id`; `agent_type` (the hooks' own; omitted when none named one); `description` (what the parent asked, from the parent's `Agent`/`Task` call whose `tool_response.agentId` is this agent — a background launch says at once, a foreground one only once it returns; omitted otherwise); `tool_calls` (its distinct calls over the whole session: a call heard on both planes shares its key and is one row, and one only the transcript saw — a call Claude Code fired no `PostToolUse` for — counts too; it was the plane that saw more until 2026-10-12, one short of the opened subagent's feed); `started_at`, `last_at` (unix ms, within the window); `tool`, `detail` (its newest call and that call's short line: a file's base name, a command's first line, a pattern, a URL — as the cockpit's tool list writes it) and `tool_at`; `doing` and `doing_from` (roughly what it is doing now, at most 60 characters with an ellipsis, made from that same newest call without another read: the call's own `tool_input.description` — the phrase Claude writes on a Bash command or an `Agent`/`Task` launch — `doing_from: "call"`; else a phrase from a small table of tool and target, `"tool"`: *Reading x.go*, *Editing x.go*, *Writing x.go*, *Searching for 'p'*, *Finding \*\*/\*.ts*, *Fetching host*, *Searching the web for 'q'*, *Using skill s*, *Loading tools*, *Calling server* for an MCP tool, and for a command *Running tests* when it runs a known test suite, *Running git status*, else *Running* and its program, past `cd`, `set -e` and assignments; else the `description` it was spawned with, `"task"`; both omitted when none says anything. Claude Code's own activity line — "Rerunning AppShell and DiffFiles tests" in its terminal list — is not written anywhere Caprock can read, so this is the nearest thing that is recorded rather than guessed); `running` (that call has no `tool.post` with its `tool_use_id`); `asking` (its newest event is a `permission.prompt`: a subagent waiting on a dialog records nothing else); `model`, `model_display` (its newest turn's model and the pricing table's short name, "Haiku 4.5"; omitted before its first turn) and `cost_usd` (the sum of its own turns' costs over the session — subagent transcript lines carry their model and usage and are priced like any turn — omitted when it has no turn or any turn the table could not price: never a 0 standing in for unknown; internal model calls are left out). `recent` lists the newest three of the `finished` — `?recent=N` asks for up to 30, which the cockpit does while its *+N finished* is open — newest stop first, each `SubagentDone`: `agent_id`, `agent_type`, `description`, `tool_calls`, `started_at`, `stopped_at` (its `SubagentStop`) and the same `model`, `model_display`, `cost_usd`; `[]` when none. The response's own `cost_usd` is every subagent of the session together, omitted when any of them is unknown. `finished` counts those that stopped within the window after at least one tool call — Claude Code also fires `SubagentStop` for small internal agents that run none, dozens an hour, and they are left out. Every query pins the session's index (`+kind`) or one of the subagent indexes of migration 0054, because SQLite otherwise chose `idx_events_kind_*` and walked every `tool.pre` in the database (1.1 s against 13 ms on the owner's); the counts, the spend and the descriptions read only those indexes, never a payload of the parent's (§ Subagent reads DDL). The cockpit reads it again at most every two seconds while subagent events arrive and every twenty seconds regardless. A paired viewer may read it, as it may read the events it is made from.

**One subagent.** `GET /v1/sessions/{id}/subagents/{agent}?limit=30&before=<call id>` → `SubagentDetail`, 404 when the session holds no event of that agent. Read when the cockpit opens a subagent's row, and again when its `SubagentStop` arrives; the live socket carries its calls in between, so nothing polls it. Fields: `agent_id`, `agent_type`; `description`, `prompt`, `subagent_type`, `parent_tool_use_id`, `background` — the parent's `Agent`/`Task` call that launched it: the call whose `tool_response.agentId` names it (a background launch says at once, a foreground one when it returns), else, for a foreground call still running, the newest unanswered call of its `subagent_type` (no type = `general-purpose`) made before its first event; all omitted when no call is linked. The parent's calls are read only within ten minutes either side of the subagent's own events. `state` is `finished` when its newest event is its `SubagentStop`, `working` when it was heard from within the live window (30 minutes), else `quiet`; `asking` as in § Subagents now; `started_at`, `last_at`, `stopped_at` (unix ms). `result` is what it returned: its `SubagentStop`'s `last_assistant_message`, else the text of the parent call's result (a foreground call's `tool_response.content`); omitted while it works and when neither was recorded. `calls` are its newest `limit` calls (default 30, at most 500) before the call with id `before`, oldest first, each `{id, tool_use_id, tool, detail, started_at, ended_at?, error?}` — `id` its `tool.pre` event id, `detail` the short line as § Subagents now writes it, `ended_at` its result's time (absent while it has none), `error` when the result was an error (Claude Code fires no `PostToolUse` for a failed call; the transcript's `tool_result` says `is_error`); a call heard on both planes is one, by `tool_use_id`. `earlier` counts the calls before the first returned. `stats`: `tool_calls` (all of them), `turns`, `tokens` (`{in, out, cache_read, cache_write}` over its turns), `duration_ms` (first event to stop, or to now while it works), `model`, `model_display`, `cost_usd` (omitted when any turn could not be priced, never a zero), and `by_tool` — at most four tool kinds, costliest first, each `{tool, calls, cost_usd?}`: a turn's cost split evenly over the tools it called, `tool` empty for the turns that called none (they only wrote). Internal model calls are left out. Two reads: the agent's own rows by `idx_events_agent` (migration 0049) and the parent's `Agent`/`Task` calls in that time range by `idx_events_session_ts`. On a copy of the owner's database (2026-10-12; its busiest session 62,000 events, the subagent 253) it took 220 ms warm before the index and 10 ms after. A paired viewer may read it, as it may read the list.

**Session todos.** `GET /v1/sessions/{id}/todos` → `{items: TodoItem[], updated_at}`: the task list the session's agent keeps for itself, rebuilt per request from its own `tool.pre` calls, nothing stored. Each `TodoItem` is `{id, text, status, active_form?}`, `status` one of `pending`, `in_progress`, `completed`, `cancelled` (OpenCode's `planned` and anything unknown read as `pending`); `updated_at` is the unix ms of the call that last changed the list, `0` with `items: []` when the session never kept one or the id is unknown — never `404`, never `null`. Four tools feed it. `TodoWrite` (Claude Code's older tool, and OpenCode's `todowrite`, stored under the same name) carries the whole list as `todos: [{content, status, activeForm}]`, so the newest call is the list; `update_plan` (Codex) the same as `plan: [{step, status}]`. `TaskCreate` (`{subject, description, activeForm}`) adds one task and `TaskUpdate` (`{taskId, status?, subject?, activeForm?, description?}`, `status: "deleted"` removes it) changes one; the ids are the ones Claude Code gives back (*Task #3 created successfully*), which number the creates 1, 2, 3 within the session, so the fold numbers them the same way rather than joining each `tool.post` — on a copy of the owner's database (2026-10-11) every session's highest `TaskUpdate` id equalled its count of `TaskCreate`. An update to an id the session never created changes nothing. Whichever of the two families changed last is the list. Only the main thread counts (a subagent's `TodoWrite` is its own list), and a call stored on both planes is folded once by `tool_use_id`. `TaskList` and `TaskGet` only read the list and are not read. The query pins `idx_events_todo` (migration 0066, § Task-list DDL), a partial index of the four tools' calls, so only they are read; through `idx_events_attr_work` it walked the session's whole index range, and SQLite's own choice, `idx_events_kind_id`, walks every `tool.pre` in the database. The cockpit's *Tasks* block reads it ([04-ui.md](04-ui.md)); a paired viewer may read it, as it may read the events it is made from.

**Session calls.** `GET /v1/sessions/{id}/calls` → `SessionCall[]`, oldest first: the main thread's priced model calls — `turn.assistant` with a `cost_usd`, no `agent_id`, not a sidechain, not internal; the newest `limit` of them (default and ceiling 20,000). Each: `id` (the event's), `ts` (unix ms), `model`, `model_display` (the pricing table's short name; omitted when it does not know the model), `cost_usd`, `tokens` (`TokenDelta`; omitted when the call reported none), `tools` (the first six `tool.pre` of the main thread with the same `msg_id` — exact, a tool_use block and the usage billed for it share the message id — each `{tool, detail}` with the short line the subagent list uses; omitted when none is linked, which is also what an agent that records no message id gets) and `tool_count` (all of them). No prose and no tool results, so a session of thousands of calls is one small response. The cockpit's spend scrubber reads it each time it opens; a paired viewer may read it, as it may read the events it is made from.

**An unmatched `/v1/` path is `404` with a JSON body**, not the dashboard. The UI is served from `/` so client-side routes resolve, which previously meant any unknown API path fell through to `index.html` — a caller that mistyped an endpoint, or used one removed in an upgrade, got `200` and a document, then failed later parsing HTML as JSON. Page routes (`/`, `/cost`, `/session/{id}`) still serve the SPA.

**`GET /v1/stats/daily?days=N` clamps `N` to the ceiling (3650), not to the default.** An out-of-range value used to fall back to 30 days, so a caller asking for everything received a month with nothing indicating truncation — summing that endpoint against `/v1/stats/summary` on a real database disagreed by $1,603. `days` unset, zero, or unparsable still means 30.

Added during T6 (same conventions; not in the spec's list):

```
GET  /v1/events?after=…&limit=…        → Event[] across all sessions (live-feed catch-up)
GET  /v1/status                        → daemon status: version, api_level, pid, uptime, data dir, executable, pricing, ingest, hooks
GET  /v1/storage                       → what the data directory holds; see § Storage below
GET  /v1/pricing                       → the pricing table in force
GET  /v1/premium                       → what the paid plan costs and where to buy it
GET  /v1/window-stop                   → the plan-window stop's state (§ Pricing table, "The plan-window stop"); 501 when the daemon has no guard
GET  /v1/keepawake                     → whether the computer is kept awake now (§ Keep awake); 501 when the daemon has no keeper
POST /v1/report/test                   → sends this week's report now → {sent:"ok"}; 502 with Telegram's error, 501 when reporting is unavailable
POST /v1/alerts/test                   → sends a test phone alert now, no licence needed → {sent:"ok"}; 502 with Telegram's error or "no bot configured"
POST /v1/pair/send-link                → sends the phone's page address to the owner's Telegram chat → {sent:"telegram", link}; loopback-only, 409 with no bot (§ Pairing endpoints)
GET/PUT/POST/DELETE /v1/telegram…      → the Telegram bridge's setup and pairing, and a share card to the paired chat (§ Telegram bridge)
POST /v1/shutdown                      → 200 (bearer-token gated; `caprock down`)
POST /v1/statusline                    → 204 (bearer-token gated) {session_id, five_hour?, seven_day?} — records rate-limit windows, then runs the plan-window stop's check
GET  /v1/statusline/{id}               → 200 (bearer-token gated) session counters for the status line; zeros for an unknown session
GET  /healthz                          → {status:"ok", version}
WS   /v1/live[?since=<seq>]            → every frame is {type, seq, data} (§ Live socket, replay); first frame is {type:"hello", seq, data:{server_time, reset}}; a "session" frame carries {session, stats}; an "event_update" frame carries an Event already sent as "event", rewritten in place (same id, new payload) — today a reply's words merged into its first transcript line (store.MergeAssistantText), which with thinking on has none: a screen holding that id replaces it, anything counting events ignores the frame; a "permission" frame carries {session_id, permission | null}; a "queue" frame carries an owned session's QueueView after any change (§ Queued messages); an "inbox" frame carries {id, deleted} after an item is saved or deleted (§ Inbox); a "brain" frame carries {id, op: added|changed|deleted, kind?, title?, auto?, session?, project?, run?, agent?} after Second Brain changes, {op: progress, phase: start|done, session?, project?, agent?, run?, added?} when an automatic read begins or ends, or {op: handoff, session, project, memories} when a new session was handed memories (§ Second Brain); a "project" frame carries a Project and an "op" frame an Op (§ Projects and shells); a "notify" frame an alert for the app (§ Notify frame); a "status" frame carries {session_id, kind, at} when input moved an owned session's status before any event (§ Nudges); a "devices" frame carries {} when the paired devices changed (§ Who may connect); an "admin" frame carries {} when a private module's attention was set or cleared, so a dashboard showing modules reads GET /v1/admin again (§ Private modules); a "footprint" frame carries GET /v1/footprint's answer without the orphan list when it changed, checked every 10 s while a live client is connected (§ Footprint); a "shells" frame carries {shells: [Shell]}, every running shell as GET /v1/shells answers, after a start and when the list changed, checked every 10 s while a live client is connected (§ Projects and shells)
```

**Permission prompts** ([ADR-035](08-decisions.md)). `permission` is the
dialog an owned Claude Code session is showing: `id` (random, per prompt),
`tool`, `detail` (the command, file, URL or query; else the compact input,
clipped at 2,000 runes), `always` (the label of the second option when the
hook's first `permission_suggestions` entry is a kind seen on a real prompt —
`addRules`, `addDirectories`, `setMode acceptEdits` — omitted otherwise and
always for `ExitPlanMode`), `since`, `agent_id` and `agent_type` (set when a
subagent asked — its dialog is drawn in the parent's terminal; `agent_type` is
the hook's, `"subagent"` when it names none; both omitted for the main
thread), `queued` (how many more are outstanding) and `waiting` (every
outstanding prompt oldest first, this one included, each with the same fields
but no `queued`/`waiting` — present only when there are two or more).
`AskUserQuestion` never becomes one: its menu is answers, not Yes and No. The
`POST` presses the key a person would — `allow` = `1`, `always` = `2` (409
when `always` is not offered), `deny` = Esc — only while `id` is the oldest
prompt **and the only one outstanding**: with two or more, which dialog the
terminal shows is unknown, and `allow`, `always` and `deny` are `422` with
nothing typed (amended 2026-10-09). `dismiss` types nothing and takes any
outstanding prompt. A prompt is cleared by an answer here, a single Enter or
digit typed into the terminal while it is the only one outstanding (with
several, the key answered one Caprock cannot name, and none is cleared), Esc
or Ctrl+C (all of them), its own call's `PostToolUse` (by `tool_use_id`, which
`PermissionRequest` does not carry and is taken from the newest `PreToolUse`
by the same agent with the same tool and input; else the same agent, tool and
input), its subagent's `SubagentStop`, the main thread's next
`UserPromptSubmit` or `Stop`, `SessionEnd`, or the process exiting; each
change is a `permission` frame. The prompts are stored, and a session
reattached after a daemon restart is waiting on them again under the same ids
(migrations 0039, 0042, 0043).

`/v1/sessions/{id}/notes` and `/v1/notes` return `AssistantNote[]` — `{event_id, session_id, project, ts, model, text, fragment}` — the prose Claude wrote, as opposed to the tool calls it made. Three rules are baked into the query rather than left to callers. **Subagent sidechains are excluded** (`agent_id = ''` and `payload.sidechain IS NOT 1`): about 45% of assistant turns are subagent chatter, so an unfiltered "what did Claude say" answers with a subagent's words roughly half the time. **`fragment` marks a note shorter than 240 runes** — mid-thought asides like "Let me check that" — so a caller can avoid presenting one as a session's conclusion; ~60% of all notes are legitimately short, so the flag qualifies a *final* note and must never be used to hide prose. **Search matches Claude's prose OR the prompt that produced it** — people remember their own question ("the SSO thing") far better than Claude's phrasing of the answer, so searching only the reply misses how memory works. Only the nearest preceding `turn.user` within a short event window counts, or every reply in an exchange would match rather than the passage that answers it; the row returned is always Claude's reply. "Preceding" is in time within the reply's own session — `(ts, id)` order, the prompt inside the reply's last 60 events there — not in event id: an id is when Caprock stored a row, and a prompt imported after its replies (OpenCode's history, a transcript read after its hooks) sits after them by id. Measured on a copy of the owner's database (2026-10-01): under the id window none of 3,048 OpenCode replies had a question, and 24 Claude Code replies matched a prompt older than the one they answered; in time order 2,878 OpenCode replies have one and Claude Code replies with a prompt in the window went from 17,679 to 17,773 of 31,521 (363 fell out of the window's edge, 457 came in). A search that matches nothing scans every note either way; the prompt lookups walk `(session_id, ts)` indexes and cost about the same. The prompt's text is `payload.prompt` (Claude Code, Gemini, OpenCode) or `payload.text` (DeepSeek Harness), read through one `COALESCE`; reading only `prompt` left every DeepSeek question unsearchable. **Wildcards are escaped**, so a query containing `%` or `_` matches literally; the corpus is one developer's own sessions, so a scan is cheap and avoids an FTS table that would need rebuilding for historical rows.

`payload.text` on `turn.assistant` is capped at **16000 runes** (`ingest.MaxAssistantText`), clipped on a rune boundary. Parser schema v1 capped at 2000 **bytes** and sliced at an arbitrary offset, which cut multi-byte prose at roughly half the intended length and left `U+FFFD` at the end of about a fifth of clipped rows — disproportionately on closing summaries. `ingest.SchemaVersion` was raised to **2** for this (it is now **3**: v3 reads `ai-title` into `sessions.title`, see § Session title DDL), and a daemon started against a v1 database re-derives the affected rows once from the transcripts still on disk (`ingest.RepairAssistantText`), rewriting only `payload.text` and leaving every other key, event id, and cost untouched. Rows whose transcript is gone keep what they have.

**One response, several lines (parser v4, 2026-10-04).** Claude Code writes one API response as several transcript lines — thinking, then text, then each tool_use — each repeating the message id and usage. The turn is keyed `msg:<id>` so usage counts once, and the first line is the row. Once Claude Code began writing a thinking line first on every response, that row had no text, and the prose on the following lines was dropped as a duplicate: on the owner's database 93% of the assistant turns stored after 2026-09-29 had no `payload.text`, against 10–28% in earlier weeks. A later line's text and tool names are now folded into the stored row (`store.MergeAssistantText`): text is appended on a new line unless the row already contains it, tools are a set union, the 16000-rune cap applies, and usage, cost and id stay as the first line set them, so a re-read changes nothing. A daemon started against a database older than v4 sets `meta.empty_text_repair_pending` and, after the port opens, reads the prose back for every main-transcript turn with an empty `text` (`ingest.RepairEmptyAssistantText`) from the session's recorded transcript, its own main file and its own subagent directory — never the whole project tree. On a copy of the owner's database it filled 745 turns in ~5 s; turns that only called a tool stay empty. The flag clears when the repair finishes.

Extended thinking is never stored at all — only `type: "text"` blocks are read — so this content cannot leak Claude's reasoning.

**OpenCode turns carry `payload.text` and `payload.sidechain` in the same shape** (`internal/opencode`, `Texts`). The text is the message's `text` parts from `part.data` in order, trimmed, joined with a newline and clipped to the same 16000 runes; `reasoning` parts are never read, and parts OpenCode marks `synthetic` or `ignored` are skipped because OpenCode, not the model, wrote them. A turn in a child session (`session.parent_id` set — an OpenCode subagent) is stored with `sidechain: true`, so the notes query keeps it out of Memory exactly as it keeps out a Claude Code subagent. Because a turn is inserted once per key, a turn stored before the importer read text, or caught while OpenCode was still writing the reply, is mended on the next read of its session: `json_set` rewrites only those two keys, only where they differ, and leaves the event id, tokens and cost alone. The poller re-reads every session on its first pass after a start, so that pass is also the backfill for history — in the poller's own goroutine, never before the port opens. Measured on a copy of the owner's database (2026-10-01): 3,258 of 9,309 OpenCode turns gained text (6,011 of the rest called tools without writing prose, 40 carry neither), 3,048 of them main-thread notes across 23 sessions and 210 subagent turns marked sidechain; the database grew by 3.0 MB (0.35%); the pass took 3.0–3.6 s against 2.5 s before, and a restart with nothing to change 2.4–3.3 s.

**OpenCode tool calls carry their input in Claude Code's shape** (`internal/opencode`, `ToolInput`): `tool.pre`, key `oc-tool:<part id>`, payload `{tool_name, tool_input, cwd, status, opencode_tool}`. `tool_input` is the part's `state.input` with every key moved to snake_case (`filePath` → `file_path`, `oldString` → `old_string`) and Grep's `include` renamed `glob`, so the tool drill-down, loop signatures and narration read an OpenCode call as they read a Claude Code one; values are kept, and an input over 32 KiB has each field over 4 KiB replaced by a `[truncated N bytes]` marker, the transcript parser's bounds. `file_path` is still what `touch_dir` is derived from, so placement is unchanged. `cwd` is bash's own `workdir` when it named one, otherwise the session's directory. Earlier versions stored a `tool_input` of at most `file_path`, so every OpenCode bash call read `(input not recorded)`. A call is inserted once per key, so those rows are mended on the next read of their session: a row whose `tool_input` holds nothing but `file_path` is rewritten with `json_set` (`tool_input` and `cwd` only) when OpenCode's input has more; the event id, key and every other field stay. As with prose, the poller's first pass after a start is the backfill. Measured on a copy of the owner's database (2026-10-04): 3,820 of 3,823 bash calls gained their command (the other 3 have no input in OpenCode either), and 8,506 of 9,927 OpenCode tool calls changed in all; the 1,413 left are reads naming only a file. The database grew by 8.6 MB (0.8%); the lookup for rows to mend costs 41 ms across all 70 sessions.

**OpenCode 2 sessions are read into the same shapes** (`internal/opencode/v2.go`). A session comes from `session_v2`, its messages from `session_message` rows of type `user`, `assistant` and a finished `compaction` (a model call with a cost and no prose); `synthetic`, `system`, `shell`, `idle` and the `*-switched` markers are not prompts or replies. Keys are unchanged — `oc-msg:<message id>`, `oc-user:<message id>` — except tool calls, which have no part row in OpenCode 2: `oc-tool:<message id>/<call id>`. A session in both `session` and `session_v2` (OpenCode 2 migrates OpenCode 1's sessions under the same ids, and OpenCode 1 also writes `session_message`) is read once: messages present in OpenCode 1's `message` table are read from there with their part-keyed tool calls, the rest from `session_message`. Cost is per message as OpenCode wrote it; `session_v2.cost` also includes the call that names the session, which no message carries, so Caprock's total for an OpenCode 2 session is lower by that call.

**OpenCode prompts are `turn.user` in Claude Code's shape** (`internal/opencode`, `PromptText`): key `oc-user:<message id>`, `ts` the message's `time.created`, payload `{prompt, cwd, sidechain}`. `prompt` is the user message's `text` parts — without those marked `synthetic` or `ignored`, and without any part that opens with `<system-reminder>` (context another program injected through OpenCode, which it does not mark) — trimmed, joined with a newline and clipped to the same 16000 runes. A message left with no text stores nothing. A child session's prompt is its parent agent's brief and carries `sidechain: true`. The first pass after a start inserts the prompts of sessions imported before they were read; the key makes every later pass a no-op. Measured on a copy of the owner's database (2026-10-01): 1,609 prompts (47 in child sessions), the pass 4.0 s, a later start 1.8–1.9 s, the database 2.9 MB larger.

**Hermes Agent is read from its state database into the same shapes** (`internal/hermes`, [ADR-069](08-decisions.md), [24-hermes.md](24-hermes.md)). `<hermes home>/state.db` (`$HERMES_HOME`, else `~/.hermes`, `%LOCALAPPDATA%\hermes` on native Windows) is opened `mode=ro` with `busy_timeout(5000)` and one connection, never `immutable=1`, and polled every 5 s; columns are asked for through `pragma_table_info`, so one an older Hermes lacks reads as NULL. Events carry `source: "hermes"` and sessions `agent: "hermes"`, under Hermes's own session id (or, for a session Caprock started, the Caprock id it is linked to — `sessions.native_id`, by folder and the time Hermes's `YYYYMMDD_HHMMSS_<hex>` id carries, `sessionlink`'s match):
- a `user` message → `turn.user`, key `hm-user:<message id>`, payload `{prompt, cwd, hermes_source, background?, sidechain?}`;
- an `assistant` message → `turn.assistant`, key `hm-msg:<message id>`, `msg_id` `hermes/<message id>`, payload `{text, model, cwd, hermes_source, background?, sidechain?}`; Hermes's compression summaries (`_compressed_summary`) and `tool` results are not stored;
- each call in its `tool_calls` → `tool.pre`, key `hm-tool:<message id>:<call id>`, the same `msg_id`, payload `{tool_name, tool_input, cwd, hermes_tool}`, with `terminal`/`read_file`/`write_file`/`patch`/`search_files`/`web_search`/`web_extract`/`delegate_task` named `Bash`/`Read`/`Write`/`Edit`/`Grep`/`WebSearch`/`WebFetch`/`Task` and a file tool's `path` stored as `file_path` (resolved against the session's `cwd` when relative);
- **usage**: Hermes keeps tokens and cost on the session row only, so each pass stores `counters − SUM(what Caprock holds for that session and agent_id)`, each part clamped at zero, on the newest `turn.assistant` the pass inserts — or, with none, on a `turn.assistant` of its own, key `hm-usage:<hermes id>:<total tokens>:<api calls>:<cost in micro-USD>`, payload `{usage_only: true, …}`. Tokens map `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens` straight (Hermes's input is fresh input); `reasoning_tokens` goes in the payload. The usage-carrying event's payload also has `cost_basis` (`actual`, `estimated`, `included`, `unknown`), `cost_source` and `provider`. `cost_usd` is Hermes's figure, never the table's: `actual_cost_usd` when Hermes says it is real (`cost_status = 'actual'` or `cost_source` `provider_cost_api`/`provider_generation_api`), else — for that same status — `estimated_cost_usd`; `estimated_cost_usd` for `estimated`; `0` for `included`/`billing_mode = 'subscription_included'`; NULL (unpriced) when Hermes has none;
- **subagents**: a child whose `model_config._delegate_from` is its parent (or a child with no branch, reset or compression marker) is stored inside the main-thread session it descends from with `agent_id` = its own id and `sidechain: true`; a branch (`_branched_from`), a reset (`_reset_from`) and the continuation of a parent that ended on `compression` are sessions of their own;
- **background**: `hermes_source` is the main thread's `source`; `background: true` when it is not one of Hermes's attended sources (`cli`, `tui`, `desktop`, `acp`);
- **ended**: a main-thread session under Hermes's own id whose `ended_at` is set is marked `ended`.

**DeepSeek Harness's injected context is not a prompt.** DSH writes the AGENTS.md/CLAUDE.md instructions (`source.kind: agent-instructions`) and its runtime-policy snapshot (`plugin`) as `user/message` records; only `source.kind: user` is stored as `turn.user` (a record with no `source` is kept). Rows imported before this are removed once, after the importer's first pass (`meta.deepseek_injected_removed`): each transcript is read again and a `turn.user` row is deleted only when its key `dsh:user:<seq>` names a record whose `source.kind` is set and is not `user` — never judged by its text; a session whose transcript is gone keeps its rows. A `turn.user` row added nothing to `session_stats` or `daily_stats`, so nothing moves there; `sessions.started_at`, `last_event_at` and `worked_at` are recomputed from the remaining events, in the same transaction, only where one equals a deleted row's `ts`. On a copy of the owner's database (2026-10-01) it deleted 5 of 22 DeepSeek prompts and changed no session time or total.

**Codex writes `payload.text` too** (`source = codex`), under the same cap: the `output_text` of the assistant messages each sampling request produced, on that request's `turn.assistant`. Threads Codex imported from another agent store nothing at all, and subagent threads keep no text. Codex turns stored before this were given their text once from the rollouts still on disk (`meta.codex_text_backfilled`), rewriting only `payload.text` on the row whose key and timestamp match. See [19-codex.md § Prose](19-codex.md#prose).

**Codex prompts and tool results are `turn.user` and `tool.post` in Claude Code's shape** (`source = codex`). A prompt: key `codex:user:<line>`, payload `{prompt, cwd}`, from the `item_completed` `UserMessage` item (else the `user_message` event), clipped to 16000 runes; none for imported or subagent threads. A result: key `codex:result:<line>` (`codex:sub:<thread>:result:<line>` in a subagent file, with `agent_id` and `sidechain`), `tool` the call's name, payload `{session_id, cwd, tool_name, tool_use_id, tool_response, is_error, exit_code?}`, `tool_response` text clipped to 8000 runes, `exit_code` only where Codex recorded one (`shell`). A call whose request ended (`task_complete`, `turn_aborted`, or the next `task_started`) with no output record gets one too, key `codex:interrupted:<call line>` (`codex:sub:<thread>:interrupted:<call line>`), `tool_response` empty and `interrupted: true`; the chat shows it as interrupted, not running. Every Codex `tool.pre` carries `tool_use_id` = Codex's `call_id`, and its `tool_input` is the call's argument object (a `function_call`'s JSON-string arguments unwrapped; `shell`'s argv `command` turned into its command line, the array kept as `argv`). Rows stored before carry neither; a one-time pass (`meta.codex_chat_backfilled`) stores the missing prompts and results from the rollouts still on disk and rewrites only `tool_use_id` and `tool_input` on the call whose key and timestamp match. See [19-codex.md § Chat](19-codex.md#chat).

Five indexes were added purely for read speed by migrations 0006 to 0010: `idx_events_kind_ts` (kind, ts) and `idx_events_cost_cover`, which additionally carries `model`, `session_id`, the token/cost columns and (since migration 0026) `internal` so the summary aggregates are answered from the index without touching the table. Together they take `/v1/stats/summary?range=all` from ~820ms to ~340ms and `/v1/history` from ~830ms to ~470ms on a 184k-event database, for roughly 30MB of index on a 306MB file. `idx_events_session_id` (session_id, id) serves the per-session event lookup behind Now, and `idx_events_kind_id` (kind, id) serves the Memory screen — both order by id, which the ts-ordered indexes cannot satisfy, so without them SQLite read every matching row and sorted it in a temp B-tree to return the newest few. Migration 0026 rebuilt `idx_events_cost_cover`, `idx_events_tool_dist` and `idx_events_attr_work` with `internal` as their last column: every aggregate filters on `internal = 0` since migration 0024, and without the column none of them covered any more — each query fetched every full row to test one flag, which put `/v1/history?range=all` at 9s on a 300k-event database. It also added `idx_events_ts_cover` (ts, internal, kind, session_id, token/cost columns) for the two range aggregates that group by kind or count distinct sessions; both pin it with `INDEXED BY`, because without ANALYZE statistics SQLite picked `idx_events_kind_id` or `idx_events_session_id` and walked the whole table — 4.8s for today's 772 events. `idx_events_ts_model` (ts, model, cost_usd) served the model mix, which every summary computes: `idx_events_cost_cover` carries `model` but leads on `kind`, so a ts-only filter could not use it — 146ms against 56ms over 30 days on a 190k-event database. Migration 0057 dropped both once later indexes had taken over their queries; see § Superseded indexes DDL. `idx_events_user_turn` (migration 0033) finds a session's first prompts for the sessions list's descriptions; see § First-prompt DDL.

Note-**search** deliberately still scans: an FTS5 index answers in 6ms against ~165ms, but it matches whole words, so searching `chestr` finds 394 rows with LIKE and 0 with FTS. People search their own sessions for fragments — half an error message, part of a path — and a faster search that misses them is not the same feature.

Anything added to the summary aggregates should either use these columns or extend the covering index it reads (`idx_events_turn_agent`, `idx_events_ts_cover`) — a column outside it costs the Go driver a table fetch per row, which is far more expensive than the same SQL timed in the sqlite3 shell suggests.

`ListEvents`, `EventsAfter`, `SessionNotes` and `SearchNotes` all clamp `limit` to `MaxEventPage` (5000) instead of falling back to a small default, which made a caller asking for everything receive a fraction of it — `notes?limit=5001` returned 200 rows where `limit=5000` returned 2372.

Plan-limit windows relayed by `caprock statusline` are **validated before storage**: a percentage outside 0–100, or a reset more than eight days ahead, is dropped rather than recorded. A reset already in the past is kept — that is a legitimately stale sample, and the dashboard labels it as such instead of formatting it as a clock.

`GET /v1/status` carries `shell_env`: `source` is `login-shell` (with `shell` and `resolved_at_ms`), `resolving` before the first resolution ends, `daemon` when it failed and none was ever had (with `error`), or `inherited` on Windows; `error` also appears beside `login-shell` when the latest refresh failed and the older copy is still served. It is what a user reads when a session Caprock started cannot find `gcloud` and a terminal can (FB-033); `caprock status` prints it as the `env:` line.

`GET /v1/status` carries `interrupted` — `{stopped_at, ids}` — the sessions
that were running when Caprock last stopped and were gone when it started
again (FB-038), omitted when there are none. The daemon writes a heartbeat
(`meta.daemon_alive_at`, unix ms) every minute; at start it reads the previous
one as `stopped_at` before overwriting it, lists the sessions of agents whose
process it watches that were worked in within the day before and were either
not ended or ended within two minutes of `stopped_at` (`store.RunningAt`, at
most 12), lets the first sweep ask their pids, and records those now ended in
`meta.interrupted`. A print-mode or SDK run is left out, at record and on
read: its transcript's `entrypoint` (Claude Code writes it on every line) is
`sdk-cli` for `claude -p` and `sdk-ts` / `sdk-py` for the SDKs, against `cli`
for the interactive terminal; hooks do not carry it, so the daemon reads the
first 256 KB of the transcript once per session. A session with no readable
transcript is kept. A later restart that interrupted nothing keeps the record.
On read, a session continued since (live again) drops out, and a record older
than 7 days is not reported.

**A session last heard from before the machine booted is ended**, whatever its
pid answers (`store.BootTime`: `kern.boottime`, `sysinfo`, or
`GetTickCount64`). A reboot restarts the pid space, so the numbers Claude Code
held are soon someone else's, and such a session stayed live, with an empty
terminal, for as long as the stranger ran.

`GET /v1/status` carries `ingest_error` — the terminal error that stopped transcript ingest, when one happened — and omits it while ingest is running. The tailer runs in a goroutine whose failure used to be logged and swallowed, so a fatal ingest error (a read-only `~/.claude` reproduces it) left the daemon reporting healthy, `caprock status` printing `backfill done`, and the dashboard showing its "No sessions yet — start `claude` in any terminal" empty state forever, while nothing was being captured at all. `caprock status` and the Now and Status screens all report it.

`/v1/stats/summary` and `/v1/history` carry `unpriced` — `{turns, tokens, models[]}` — the volume in range whose model has no row in the pricing table, and which models caused it. It is **omitted entirely when everything in range was priced**, which is the normal case. A model missing from the table leaves `cost_usd` NULL (the rollup logs "model not in pricing table; cost left unknown"), and every aggregate flattens NULL with `COALESCE(SUM(cost_usd),0)` — so tens of thousands of tokens of an unpriced model summed to exactly `$0.00` and rendered as a confident, indistinguishable-from-free number. That is an invented number (rule 6), and it is certain to occur the day a model ships newer than the pricing table, or on a gateway whose model ids do not normalise. The models are **named**, not merely counted: an unknown model id is something a user can report or add a pricing override for, whereas "some tokens are unpriced" is not actionable. `cost_usd` continues to mean "the cost we could price", so the two are reported side by side and never summed.

`GET /v1/stats/trends` is what the Now screen's Today cells are set against (see [04-ui.md](04-ui.md) § Today's trends): `{days, cut_min, series[], burn?}`. `series` is the previous `days` (14) local days, oldest first, then today; each entry is `{day, cost_usd, sessions, turns, tool_calls, hit_rate?, burn_usd_per_hour?, active}`, and every figure but the burn is **cut at the same time of day as now** (`cut_min`, minutes after local midnight): yesterday's `cost_usd` is what yesterday had spent by this hour, because a morning set against whole days reads low every morning. `sessions` counts the sessions with any event by the cut, as the summary counts today's; `hit_rate` (0–1) is absent with no input at all. `active` is whether the day had any priced turn at any hour — the client takes its median over active days only, so a weekend off is not a usual of zero. `burn_usd_per_hour` is the median of the day's **active 10-minute windows** (UTC-aligned windows in which anything was spent, as dollars per hour), over the whole day; `burn` is `{median_usd_per_hour, windows, days}` over the previous days' active windows, omitted when there is none — the figure *Burn now*, itself the last 10 minutes, is set against. Nothing is withheld here: the client says "not enough history" below five active days. It follows `?agent=` (a 400 for an unknown one) and ignores `?range=`. One grouped range scan per (5-minute bucket, session, kind) off `idx_events_ts_cover` — five minutes divides every UTC offset, so a bucket never straddles a local midnight, and a day's cut is at most one bucket late. On a copy of the owner's 1.6 GB database, 15 days (200k events, 10k groups): 0.14 s in the sqlite shell, 0.28 s warm through the Go driver (2026-10-14), so it is cached per agent and local day for 5 minutes (`trendsTTL`, then refreshed in the background, served stale up to 30 minutes) and warmed at start for every agent together; the client draws today's point from the live summary. The rollups cannot answer it: `daily_stats` has no time of day, no turn or tool counts and no agent.

`/v1/stats/summary` carries `usual` — this machine's own baseline over the last 30 days, which the cockpit sets a session's headline against (*▲ 38%*, [04-ui.md](04-ui.md) § Inspector): `{days, burn?, cost?, tokens?, cache?}`. `burn`, `cost` and `tokens` are distributions, each `{n, q[11], mean}` — the sample count, the nearest-rank minimum, every tenth percentile and maximum, ascending, and the samples' mean (the spend chart's pace line sets each bar, itself a mean of its active hours, against `burn.mean`; a client given no `mean` by an older daemon draws no usual line). `burn` is dollars per **active session-hour**: every clock hour in which one session made at least five priced calls costing more than nothing, its spend in that hour — a session's hour, not the machine's, because four sessions at once are not one burning four times as fast. `cost` and `tokens` are every session's total over the window (tokens: input with cache reads and writes). `cache` is the window's hit rate, 0–100. A distribution with fewer than 20 hours (`burn`) or 8 sessions (`cost`, `tokens`, `cache`) is **omitted**, and `usual` itself is omitted when nothing is left: a new user is shown nothing rather than a median of three (rule 6). It follows `?agent=` like the figures beside it, and ignores `?range=`: it is always the last 30 days. One grouped scan of the priced turns per (session, clock hour) off the covering `idx_events_turn_agent` — 0.02 s warm, 0.12 s cold for 30 days on a 1.7 GB copy of the owner's database (2026-10-13) — cached for 10 minutes and then refreshed in the background (`usualTTL`, served stale up to a day), and warmed at start, so no request counts it on the way.

They also carry `background` — `{turns, tokens, models[]}` — measured token usage from **known internal product machinery** (today, Codex's hidden `codex-auto-review` approval reviewer). This is a different state from `unpriced`: it is not an error and asks nothing of the user, so it is **kept out of every user-work total** (sessions, turns, token and cost sums, the model mix, the projects roll-up, the daily cap and the weekly report) and reported beside them as a quiet "background usage" line with no dollar value — OpenAI publishes no price for the id, and inventing one would violate rule 6. The raw events stay in `events` for auditability; only the aggregates exclude them. Classification lives in `internal/modelclass` as an explicit allow-list (not a prefix match) and is recorded **per-event** by migration 0024 plus the write path — Codex writes the review turns into the *same* session as the work they review, so a session-level flag would hide the real turns beside them. A future id must be investigated before Caprock hides it.

`GET /v1/status` may carry `desktop` — `{five_hour_pct, seven_day_pct, at, stale}` — the Claude **desktop app's** own plan usage, read on request from `plan-usage-history.json` in the app's support directory. It is omitted entirely when the app is absent, has never run, or wrote something we cannot parse; most people do not use it, so absence is a normal answer rather than an error.

What that file holds bounds what may ever be said about it: a timestamp and two window percentages. **No tokens, no cost, no conversation content**, so this can never state what the desktop app cost — only how much of a window it consumed. It is also written only while the app runs (27 samples in a day on one real machine, against ~290 at its five-minute interval), so a reading older than 20 minutes is flagged `stale` and the UI says the app has been closed since. Nothing is stored and nothing is polled.

#### Storage

`GET /v1/storage` reports what Caprock keeps on disk: `{data_dir,
total_bytes, files[], database?, measured_at?, measure_ms?, error?, measuring?,
reclaimable_bytes, returns_free_space, growth_bytes_per_day_est,
retention_days}`.

- **`files`** is every top-level entry of the data directory, `{name, bytes,
  dir?}`, largest first; a directory is the sum of the regular files under it.
  `total_bytes` is their sum. Both are read on every request — a stat of a few
  dozen files.
- **`database`** is the composition: `page_size`, `page_count`, `free_pages`,
  `tables[]` (`{name, data_bytes, index_bytes}` from `dbstat`, each index folded
  into its table), and the events table read once — `events`, `payload_bytes`
  (`octet_length` of the raw JSON, so bytes rather than characters),
  `oldest_ts`, `agents[]` and `kinds[]` (`{name, events, payload_bytes}`, the
  agent taken from the session row), `recent[]` (the last 7 and 30 days) and
  `older[]` (older than 30 and 90 days: what a `retention_days` of that length
  would delete), each `{days, events, payload_bytes}`.
- **It is cached, not computed per request.** `dbstat` walks every page and the
  breakdown reads every event; on an 857 MB database the two measured 8 s warm
  and 14 s cold
  through this driver (2026-10-01), and 4.8 s reading the whole 2.2 GB file on
  the owner's machine (2026-10-13). **It is measured only when wanted**: a
  request that finds the cached figures a day old (`storageMaxAge`), or none,
  starts one measurement in the background and answers at once with what it
  has and `measuring: true`; and once a day while the daemon is idle (nothing
  recorded for 30 minutes) it measures on its own, so the panel finds figures
  ready. Never on a fixed timer: it used to run a minute after every start and
  every 30 minutes whether or not anyone looked. `database` is absent until the
  first one finishes. A failed measurement keeps the previous figures, sets
  `error`, and is retried no sooner than a day later. The breakdown is one scan of `events` in rowid order, folded in Go:
  it was a `GROUP BY` over a join, which SQLite sorted through temp files
  carrying every payload (11 s in the sqlite3 shell on a 1.8 GB database,
  against 0.4 s for the scan; 2026-10-10).
- **`reclaimable_bytes`** is `free_pages × page_size`: free space inside the
  file. **`returns_free_space`** is true when the database is in
  `auto_vacuum=INCREMENTAL` mode, so the daemon gives those pages back to the
  disk while idle; false on a database created before 2026-10-13 until its one
  idle-time VACUUM has run (§ Payload compaction and auto-vacuum). Read with a
  `PRAGMA` on every request. Nothing in the panel asks the user to run anything:
  it says which of the two is true.
- **`growth_bytes_per_day_est` is an estimate and named as one** (rule 6): the
  payload recorded over the last 30 days, per day, times the events table's
  on-disk bytes (data and indexes) over the payload it holds. `0` when there is
  nothing to scale by.
- **A paired device may read it** — sizes and counts only; the data directory
  path is already in `/v1/status`.

#### Resources

`GET /v1/resources` (2026-10-10) reports what each live session's process tree
and Caprock itself cost the machine. Code: `internal/daemon/resources.go`,
`internal/procstat` (the process table: one `sysctl kern.proc.all` on macOS,
gopsutil on Linux and Windows; each process's CPU time from gopsutil, and its
own memory as below). Only reads: nothing is signalled except by the reap below.

```json
{"at": 1791400000000,
 "sessions": [{"session_id": "…", "pid": 4242, "cpu_pct": 182.4, "mem_bytes": 1342177280, "procs": 7, "warm": true,
               "top": [{"pid": 4300, "name": "node vite", "cpu_pct": 150.2, "mem_bytes": 1181116006}],
               "hot": true, "over_since": 1791399800000, "max_proc_bytes": 1181116006, "heavy": "big"}],
 "caprock": {"daemon": {"pid": 1, "name": "caprock", "cpu_pct": 1.2, "mem_bytes": 220000000},
             "app": {"pid": 2, "name": "caprock-app", "cpu_pct": 2.0, "mem_bytes": 48000000},
             "webview": {"count": 4, "cpu_pct": 2.1, "mem_bytes": 446000000,
                         "procs": [{"pid": 3, "name": "com.apple.WebKit.WebContent", "cpu_pct": 2.0, "mem_bytes": 346000000}]},
             "hosts": {"count": 19, "mem_bytes": 95000000, "cpu_pct": 0, "orphans": 15, "reapable": 15,
                       "list": [{"pid": 2267, "state": "unreachable-idle", "reap": true, "ours": false, "abandoned": true, "child": "zsh"}]}},
 "thresholds": {"cpu_pct": 100, "mem_bytes": 2147483648, "after_s": 60, "interval_s": 5},
 "machine": {"cpus": 10, "load1": 3.42, "mem_total": 17179869184, "mem_available": 4342251520},
 "error": "…"}
```

- **A session's tree** is its process — `sessions.pid` of a session not
  ended, or the agent or shell a pty-host runs for this daemon (a shell has no
  session row) — and every process below it. `cpu_pct` is summed over the
  tree, as a percentage of one core between two samples: `250` is two and a
  half cores. `mem_bytes` is each process's own memory, summed — what the
  OS's process manager shows, not the resident set, which counts the file
  pages a process maps (the daemon maps its whole database: 544 MB resident,
  122 MB footprint, 2026-10-10). macOS: the physical footprint
  (`proc_pid_rusage`); Linux: `RssAnon + RssShmem`; Windows: private bytes.
  `warm` is false on a tree's first
  sample, before there is a rate; its CPU is then `0`. `top` is the three
  busiest processes by CPU, named for a person: the program, and for an
  interpreter the script it runs (`node vite`, `python3 pytest`).
- **Hot.** `over_since` is when the tree last went over a limit — CPU at or
  above `thresholds.cpu_pct` (one core) or memory at or above
  `thresholds.mem_bytes` (2 GiB) — and `hot` turns on once it has stayed over
  for `after_s` (60 s). It stays on through a dip and turns off after 15 s
  under both. The limits are round numbers chosen to separate "an agent
  waiting on the model" (a few percent) from "the machine will feel this", not
  measured thresholds.
- **Heavy** (2026-10-22). `max_proc_bytes` is the tree's largest process's
  own memory. `heavy` is `big` when that process holds max(3 GiB, a fifth of
  `machine.mem_total`), `growing` when its readings — one written down every
  10 min, kept 4 h — cover 2 h or more, gained 1 GiB or more and never fell
  back by more than a twentieth between two; absent otherwise, and on a
  shell. Long sessions of an agent's CLI grow: on the owner's Mac one Claude
  Code process had a 2.7 GB footprint (peak 3.7 GB), 2 GB of it compressed,
  with a resident set of 0.6 GB (2026-10-22) — why memory here is the
  footprint, never the RSS. The figures are chosen, not measured. The
  readings exist only while the meter samples, so "for hours" is measured by
  their times, gaps and all.
- **Caprock itself.** `daemon` is this process; `app` is the desktop app's
  shell process (`caprock-app`), absent when it is not running. `webview`
  (2026-10-13) is the processes that draw the app's window, absent without
  the app: on macOS the WebKit helpers (`WebContent`, `GPU`, `Networking`)
  macOS holds `caprock-app` responsible for
  (`responsibility_get_pid_responsible_for_pid` through libSystem; they are
  launchd's children, so the process tree cannot say whose they are), and
  on Windows and Linux the app's own child processes (WebView2,
  WebKitGTK). On the owner's Mac they were 290–360 MB of WebContent, 60–70 MB
  of GPU and 14 MB of Networking (2026-10-13) — more than the app process
  itself, and uncounted before. `procs` lists them, largest first.
  `hosts` is every `caprock pty-host` of this user on the machine, whichever
  Caprock started it, with the verdict on each (§ Terminal holders, Orphans).
- **When it samples.** Every 5 s, and only while a `/v1/live` client is
  connected or `GET /v1/resources` was asked within the last 15 s; a daemon
  nobody watches reads no process table. Each sample goes out as a
  `{type:"resources", seq, data:<the object above>}` frame on `/v1/live`. A
  `GET` answers the last sample when it is under 5 s old, otherwise takes one.
- **The machine as a whole** (2026-10-18, ADR-067): `machine` is read on
  every sample, before the process table, by `procstat.Machine` — `cpus` the
  logical cores (`runtime.NumCPU`), `load1` the one-minute load average
  rounded to 0.01 (absent on Windows, which keeps none: gopsutil's emulation
  would hold a goroutine and a PDH counter for the life of the daemon),
  `mem_total` the physical memory and `mem_available` what can be taken
  without swapping as the OS judges it (gopsutil `VirtualMemory`: macOS free
  plus inactive pages, Linux `MemAvailable`, Windows available physical
  memory). Absent when the OS gave none of it, and from a daemon before it.
  `memory` (2026-10-22) is the machine's memory split by who holds it, with
  the OS's pressure (§ System memory).
  Another computer reads it through `/v1/m/{id}/v1/resources`. Nothing acts
  on it yet: the New-agent line *"This Mac is busy — run it on …?"* waits for
  thresholds set from OQ-19's measurement ([12-risks.md](12-risks.md)).
- **A paired device may read it**; it may not reap.

`GET /v1/resources/history[?since=<unix ms>]` (2026-10-15) is the same
figures over the last hour, for the status bar's resource popover
([04-ui.md § Status strip](04-ui.md)). Code: `internal/daemon/reshistory.go`.

```json
{"interval_s": 5, "capacity": 720,
 "at": [1791400000000, 1791400005000],
 "caprock": {"cpu": [3.8, 4.1], "mem": [450887680, 451000320]},
 "all": {"cpu": [0, 112.3], "mem": [1048576, 5242880]},
 "sessions": {"<session id>": {"cpu": [null, 12.3], "mem": [1048576, 2097152]}}}
```

- **What is kept.** Every sample the meter takes (§ When it samples above),
  in a ring of `capacity` slots — an hour at `interval_s` — oldest dropped
  first. It takes no sample of its own and does not keep the meter sampling,
  so the history has gaps where no window was open; asking it is a read.
  `since` answers only samples taken after that time (the popover asks after
  the newest it has, so the hour is fetched once).
- **Series.** Each array lines up with `at`, oldest first. `caprock` is the
  daemon, the terminal holders, the app and its web view summed; `all` is
  every session's tree summed (a CPU before its first rate counts as none);
  `sessions` has one series per session that appears in the window, `null`
  where it was not running or where its CPU had no rate yet. CPU is rounded
  to 0.1; memory is kept in KiB and answered in bytes.
- **Cost** (measured 2026-10-15, Apple M1 Pro under load, ten sessions — more
  than the owner runs at once, `BenchmarkResourceHistory`): a full hour holds
  157 KB of heap; keeping a sample takes 0.15 µs and allocates nothing; the
  full hour answered as JSON is 135 KB and 1.8 ms. A preview daemon with two
  sessions answered its first 20 minutes in 15 KB and 2.5 ms.
- **A paired device may read it**, as it reads `GET /v1/resources`.

`POST /v1/resources/reap` → `{reaped[], failed[]?, kept[]}` (verdicts as in
`hosts.list`; `failed` is `{pid, error}`): stops every holder whose verdict is
`reap`, and lists in `kept` the orphans left running because something still
runs in them. Machine only — not on a paired device's list. The daemon also
sweeps on its own, five minutes after start and then every 10 minutes, and
stops the same holders the button does: every one whose verdict is `reap`,
whichever Caprock started it (2026-10-13). It used to stop only holders of
its own data directory, so a preview or test daemon could not sweep another
install's leftovers — which left eleven idle shells from deleted preview
stands, started by a Homebrew `caprock` and an older app bundle, running on
the owner's machine through every hourly sweep. The rule that makes a holder
reapable — its program has exited, or nothing can reach it and it holds only
an idle shell — is what makes stopping it safe whoever runs the sweep, and
nobody else cleans up after a user's Caprock. Rule 7 allows it because every
one is a Caprock's own holder, a process some Caprock started; a holder
running an agent or a command is never stopped. Each reap that stops
anything is written to the footprint's `actions` (§ Footprint).

#### System memory

The machine's memory as a whole (2026-10-22): how full it is, who holds it,
and ending the idle agents Caprock started on the user's click. A user's Mac
froze with agents holding all its memory while the status bar said only what
the agent in front used. Code: `internal/procstat/sysmem*.go` (the readings),
`internal/daemon/sysmem.go` (the split, the states, the end). The status
bar's item and popover are in [04-ui.md § Status strip](04-ui.md).

**On every resource sample** (§ Resources, *When it samples*: every 5 s, only
while a dashboard is open) the `resources` frame and `GET /v1/resources`
carry `memory`, totals only — the live socket reaches every paired device:

```json
"memory": {"label": "Mac", "total": 17179869184, "used": 14110726144,
           "swap_total": 9663676416, "swap_used": 8957198336, "swap_growing": false,
           "pressure": "warn", "level": "tight",
           "agents": 6657199308, "agent_count": 7, "caprock": 419430400, "other": 7034096436}
```

- **Read from.** macOS: `hw.memsize`, `host_statistics64(HOST_VM_INFO64)`
  through libSystem (no process started), `vm.swapusage` and
  `kern.memorystatus_vm_pressure_level` (1 `normal`, 2 `warn`, 4
  `critical`). `used` is Activity Monitor's *Memory Used*: app memory
  (anonymous pages less purgeable), wired and compressed; cached files are
  not in it. Linux: `/proc/meminfo` (`used` is `MemTotal − MemAvailable`)
  and, where the kernel keeps PSI, `/proc/pressure/memory`: `critical` when
  `full avg10` ≥ 10, `warn` when `some avg10` ≥ 10 — round numbers chosen,
  not measured; Linux has no levels of its own. Windows:
  `GlobalMemoryStatusEx` (gopsutil); no pressure and no swap are read, so
  `pressure`, `swap_total` and `swap_used` are absent.
- **`label`** is `Mac`, `Linux`, `Windows`, or `Memory` elsewhere.
- **`level`.** `critical` when `pressure` is `critical` or `swap_growing`;
  `tight` when `pressure` is `warn` or `used` is 85% of `total` or more;
  else `normal`. `swap_growing` is swap in use that grew by 256 MiB or more
  within the last 30 s of samples. 85%, 256 MiB and 30 s are chosen, not
  measured: room for one more agent on a 16 GB machine, and well above the
  trickle an idle Mac swaps.
- **Per-process memory** is the process's own, as in § Resources: on macOS
  its physical footprint (`proc_pid_rusage` with `RUSAGE_INFO_V2`,
  `ri_phys_footprint`, called through libSystem with purego — no cgo),
  compressed pages included, which is what Activity Monitor shows; the
  resident set only if that call fails. Linux `RssAnon + RssShmem`, Windows
  private bytes.
- **The split.** `agents` is every live session's process tree that is not a
  shell (§ Resources' trees, each process tree once: `/clear` lists one
  process under two ids), `agent_count` how many; `caprock` the daemon, the
  terminal holders, the app and its web view; `other` the rest of `used`,
  the system's own memory included. Per-process memory is each process's
  own (§ Resources), so the parts are estimates of who holds `used`, not an
  exact partition of it.
- **Test hook.** `CAPROCK_TEST_MEMORY_PRESSURE=normal|warn|critical` in the
  daemon's environment replaces the OS's `pressure` and sets
  `"simulated": true`; any other value is ignored. For screenshots and
  browser checks only; Caprock never sets it.
- **Cost** (measured 2026-10-22, Apple M1 Pro, 16 GB, 669 processes,
  `BenchmarkSystemMemory`): 7.4 µs per sample.

`GET /v1/system/memory` is the popover's list, read only while it is open:

```json
{"at": 1791400000000,
 "memory": {…the object above…},
 "agents": [{"session_id": "…", "pid": 4242, "mem_bytes": 1932735283, "procs": 9,
             "owned": true, "state": "idle", "idle_since": 1791397480000, "endable": true,
             "max_proc_bytes": 1610612736, "heavy": "growing", "restartable": true}],
 "apps": [{"name": "Google Chrome", "mem_bytes": 7348010288, "procs": 49},
          {"name": "colima", "mem_bytes": 8770000000, "procs": 5, "vm": true}],
 "idle_end": {"count": 3, "mem_bytes": 2576980377, "session_ids": ["…"]},
 "error": "…"}
```

- **`agents`**, largest first: each tree in `memory.agents`, with `owned`
  (Caprock started it) and `state` — `working` (mid-turn as the keep-awake
  keeper reads it, or anything drawn or written in the last 2 min), `waiting`
  (a permission prompt or question open, a message queued, a subagent at
  work, paused, or the turn ended asking the user something), or `idle`,
  with `idle_since` its last activity (§ Ending idle sessions' *last
  activity*). `endable` is an idle agent Caprock started that is not the
  orchestrator or one of its workers; a session another terminal started is
  never endable.
- **`max_proc_bytes`, `heavy`** are the tree's, as in § Resources' *Heavy*.
  **`restartable`** is an agent Caprock started, not the orchestrator or a
  worker, whose state is not `working`: Restart it fresh may run now.
- **`apps`**: the three other apps using the most, every process of this
  user outside the agents' trees and Caprock's own counted once under its
  app — on macOS under the process macOS holds responsible for it, named
  after its outermost `.app` (Chrome's renderers under *Google Chrome*), or
  the program's name. Other users' processes cannot be read and stay in
  `memory.other`. **`vm`** marks an app one of whose processes holds a
  virtual machine's guest memory, told by the process table's name alone:
  `com.apple.Virtualization.VirtualMachine` (Apple's Virtualization
  framework: colima, lima, Docker Desktop, UTM; cut to 16 bytes by macOS),
  `qemu-system-*`, `vfkit` or `krunkit`. **Absent for a paired device**, which reads totals and
  agents, not what else runs on the machine. Cost (same machine and date):
  7.8 ms, 89 ms on the first ask while the executables are looked up once.
- **`memory.other` here** is the larger of the frame's (the rest of `used`)
  and what every app read holds together, not only the three listed. The
  two are counted differently: `used` is RAM, compressed memory at the size
  it takes in the compressor and swapped-out memory not at all, while an
  app's size is its footprint, which counts its compressed and swapped-out
  pages at full size. An app whose memory is mostly compressed or in swap is
  far bigger by footprint than its share of `used` — an idle virtual
  machine, whose whole guest RAM is one process. Measured on the owner's
  Mac (2026-10-22, 16 GB): colima's `com.apple.Virtualization.VirtualMachine`
  had an 8.2 GB footprint (`footprint`: 8 GB of it the guest's memory) with
  0.5 GB resident and 7.6 GB of swap in use, and the popover listed it at
  8.2 GB under *Other apps and the system* at 7.6 GB. A group is never
  smaller than its members, so it takes their sum; `agents + caprock +
  other` may then pass `used`, and the popover says why.
- **`idle_end`** is what the button would end: the `endable` agents, how
  many and their memory together.

`POST /v1/system/memory/end-idle` `{"session_ids": ["…"]}` (1 to 256) →
`{"ended": ["…"], "skipped": [{"session_id": "…", "why": "working"}]}`.
Each named session is judged again under its queue lock and ended only if it
is still `endable`; `why` is its state, `not started by Caprock`, or
`already ending`. Ending is End's, the same as closing an idle agent's tab:
asked first, so the transcript is written, killed after the grace; the
conversation is continued later like any ended one. The session is not
marked as ended for idling (§ Ending idle sessions) — the user ended it.
A confirmed user action, never automatic; machine only — on no paired
device's list.

`POST /v1/system/memory/restart` `{"session_id": "…"}` →
`{"ended": true, "cwd": "/…", "agent": "claude"}` or `{"ended": false, "why":
"working"}`: the first half of **Restart it fresh**, offered on a heavy
agent. The daemon judges the session under its queue lock — started by
Caprock (`not started by Caprock` otherwise), `restartable` (`why` is its
state otherwise), not already ending — ends it with End, and answers once the
process has exited (up to End's grace and 3 s more; `it has not exited yet`
past that). The dashboard then continues it as Continue does, `POST
/v1/agents` with `resume` and `fork: false` in `cwd`: same conversation, a
new process. A click, never automatic; machine only.

#### Footprint

`GET /v1/footprint` (2026-10-13) says what Caprock itself costs this machine
— memory, CPU, disk space, the daemon's own disk I/O — and which duplicate or
orphaned Caprock processes make it cost more, so a person can tell whether a
slow machine is Caprock or not, and which processes on the machine look
abandoned (`orphans`, 2026-10-14, [ADR-059](08-decisions.md)). `caprock
doctor` prints it (§ below). Code: `internal/daemon/footprint.go`,
`scan.go`, `orphans.go`, `footprint_io.go`, `actions.go`.

`GET /v1/footprint?orphans=1` answers with the orphan list (the open doctor
panel asks so every 10 s): the last scan's while it is younger than 30 s
(`orphanListTTL`), a new one otherwise. `&fresh=1` takes one now (the
panel's Check now, `caprock doctor`). Without `orphans` it carries the last
scan's counts and an empty list.

**On the live socket** (2026-10-19): while a `/v1/live` client is connected
the daemon builds that same answer every 10 s from the resource meter's last
sample (taking none of its own, and not counting as asking, so it never
keeps the meter sampling by itself) and sends it as a `{type:"footprint",
seq, data}` frame when anything but `at` changed since the last one sent.
The status strip follows the frames and asks `GET /v1/footprint` on mount
and once a minute as the fallback for a daemon before them; it asked every
10 s from every window. Code: `internal/daemon/livepush.go`.

```json
{"at": 1791877758573, "daemon_running": true, "data_dir": "…/caprock", "exe": "…/bin/caprock",
 "memory": {"daemon": {"pid": 1, "name": "caprock", "cpu_pct": 1.2, "mem_bytes": 340000000},
            "app": {"pid": 2, "name": "caprock-app", "cpu_pct": 0.4, "mem_bytes": 45000000},
            "webview": {"count": 4, "cpu_pct": 2.1, "mem_bytes": 446000000,
                        "procs": [{"pid": 3, "name": "com.apple.WebKit.WebContent", "cpu_pct": 2.0, "mem_bytes": 346000000}]},
            "hosts": {"count": 26, "mem_bytes": 260000000, "cpu_pct": 0, "orphans": 11, "reapable": 11},
            "other_daemons_mem_bytes": 0, "total_mem_bytes": 1091000000, "total_cpu_pct": 3.7},
 "disk": {"total_bytes": 2300000000, "database_bytes": 2219000000, "wal_bytes": 6000000, "pastes_bytes": 25000000,
          "logs_bytes": 15000000, "binaries_bytes": 51000000, "other_bytes": 5000},
 "disk_io": {"interval_s": 60, "samples": 61,
             "last_minute": {"read_bytes": 1200000, "write_bytes": 300000, "seconds": 60},
             "last_hour": {"read_bytes": 90000000, "write_bytes": 20000000, "seconds": 3600},
             "since_start": {"read_bytes": 400000000, "write_bytes": 90000000, "seconds": 7200}},
 "duplicates": {"daemons": [{"pid": 9, "exe": "/opt/homebrew/bin/caprock", "data_dir": "/tmp/stand", "mem_bytes": 33000000, "started_at": 1791877083828}],
                "apps": [{"pid": 2, "exe": "/Applications/Caprock.app/Contents/MacOS/caprock-app", "mem_bytes": 45000000, "started_at": 1791877274439}],
                "other_install_holders": {"count": 11, "orphans": 11, "exes": [{"exe": "/opt/homebrew/bin/caprock", "count": 9}]}},
 "orphans": {"scanned": true, "at": 1791877758573, "count": 2, "by_kind": {"claude": 1, "mcp_server": 1}, "mem_bytes": 289406976,
             "list": [{"pid": 48120, "started_at": 1791784158573, "kind": "claude", "label": "claude",
                       "cmd": "claude --session-id 2f6c --api-key [hidden] -p \"summarise the logs\"",
                       "exe": "/Users/you/.local/share/claude/versions/2.1.296", "cpu_pct": 0.1, "mem_bytes": 222298112,
                       "why": "A claude whose session ended (last heard from 25h ago), still running with no terminal."}],
             "note": "…"},
 "verdicts": [{"level": "warn", "code": "orphans", "text": "11 of 26 terminal holders are orphans …"}],
 "actions": [{"at": 1791877800000, "what": "stopped 11 orphaned terminal holders (11 holding only an idle shell and 11 left by a Caprock whose data directory is deleted)"}],
 "error": "…"}
```

- **`memory`** is the resource meter's last sample (§ Resources; asking
  counts as looking, so the meter samples for 15 s after): `daemon`, `app`,
  `webview` (the app's window: on macOS the `com.apple.WebKit.*` helpers
  macOS holds `caprock-app` responsible for —
  `responsibility_get_pid_responsible_for_pid`, since they are launchd's
  children, not the app's; elsewhere the app's own child processes), and
  `hosts` (the holder summary without the list). `other_daemons_mem_bytes`
  is `duplicates.daemons` summed; `total_*` is all of it. CPU is `0` until
  the meter has two samples.
- **`disk`** is the data directory's top-level entries (§ Storage) sorted
  into groups: `database_bytes` is `caprock.db` with `-wal` and `-shm`
  (`wal_bytes` the WAL alone), `pastes_bytes` the `paste/` directory,
  `logs_bytes` every `*.log`, `binaries_bytes` the app's `bin/` and the hook
  shim, `other_bytes` the rest.
- **`disk_io`** is the daemon's own reads and writes: its cumulative
  counters read at start and once a minute (macOS `proc_pid_rusage`
  `ri_diskio_bytesread/written`; Linux `/proc/self/io`
  `read_bytes/write_bytes`; Windows `GetProcessIoCounters`, which counts
  reads the file cache answered too and so reads higher). Sixty-one readings
  are kept in memory — an hour — and nothing is written to disk.
  `last_minute` is between the two newest readings, `last_hour` between the
  oldest kept and the newest (`seconds` says how long while the daemon is
  younger than an hour); both are absent until there are two readings.
- **`duplicates.daemons`** is every other `caprock up --foreground` of this
  user, the data directory it was started with (`--data-dir`, else
  `CAPROCK_DATA_DIR`; absent for the default) and its memory. `apps` is
  every `caprock-app`. `other_install_holders` counts the holders whose
  executable is outside this install (the daemon's directory, the holder's,
  and on Windows `<data_dir>/ptyhost/bin`); a holder whose executable has
  since been deleted (an upgraded Homebrew Cellar, a replaced app bundle) is
  named by its absolute `argv[0]`.
- **`orphans`** is the processes that look abandoned (`internal/daemon/orphans.go`).
  `scanned` is true when `list` was taken for this answer; otherwise `count`
  and `by_kind` are the last scan's (the 10-minute sweep after its reap, the
  doctor's last look, or — the first time a footprint is asked — one taken
  then) and `list` is empty. `at` is when the counted scan ran; `mem_bytes`
  is every listed process's memory together (2026-10-18; absent before).
  Each item:
  `pid` and `started_at` (unix ms; together they name the process), `kind`,
  `label` (the program and, for Caprock, its subcommand), `cmd` (2026-10-18:
  the command line — the program by its base name, an argument with a space
  quoted, whitespace folded, the value of any flag or `KEY=VALUE` whose name
  says token, secret, password, API key, auth, credential, bearer, cookie or
  private key replaced by `[hidden]`, a URL's `user:password@` hidden, cut to
  160 characters; absent when argv cannot be read), `exe`, `data_dir` and
  `data_dir_gone` (a Caprock daemon's or
  holder's data directory, when it can be told), `cpu_pct` (absent until
  two samples; the orphan list has its own sampler, so it never resets the
  session meter's rates), `mem_bytes`, `why` (a sentence) and `auto` (a
  holder the sweep stops on its own). Kinds: `caprock_daemon` (another
  `caprock up --foreground`), `caprock_holder` (a holder whose verdict is an
  orphan, any install), `caprock_old_holder` (2026-10-18: a holder this
  daemon still lists — a live session — whose executable is outside its
  install directories, the same ones as `other_install_holders`; at least
  two minutes old; never `auto`; only when a daemon answers, since without
  one there is no install to compare with), `caprock_other` (another caprock
  command whose parent is gone), `claude` (no terminal, and its parent gone,
  or the latest ended session in `sessions` with its pid started after the
  process did), `codex` (2026-10-18: the Codex CLI — named `codex`, argv[0]
  `codex`, or node/bun running `@openai/codex` — by the same rule as
  `claude`; `codex app-server` and anything under an `app-server-daemon`
  directory are the Codex app's service and never listed), `mcp_server`
  (parent gone, argv or name says MCP), `claude_child`
  (parent gone, `CLAUDECODE` set in its environment). Parent gone: pid 1, a
  `systemd`/`init`/`launchd` parent (a Linux subreaper), or — Windows does
  not reparent — a parent pid not running or naming a younger process. Never
  listed: a controlling terminal (`e_tdev` on macOS, `tty_nr` on Linux;
  Windows has none to check), a live session's process tree, another user,
  younger than two minutes (`ptyhost.OrphanAge`), an executable inside a
  macOS app bundle, this daemon, the doctor, and the daemon it asked.
  `note` says what a scan could not look at (Windows; no daemon, so no
  sessions).
- **`verdicts`** are `{level: "ok"|"warn", code, text}`, warnings first.
  Warnings: `duplicate_daemon` (another daemon runs), `duplicate_app` (more
  than one app), `orphans` (holders no Caprock will reattach to),
  `stray_processes` (a `claude`, a `codex`, an MCP server or a Caprock
  command in `orphans`; only `claude_child` ones are said at level `ok`, and
  `caprock_old_holder` ones are left to `other_install_holders`),
  `database_large` (over 2 GiB), `wal_large` (over 256 MiB),
  `disk_reads_high` (the daemon read over 500 MiB in the last hour) and,
  only in `caprock doctor`'s own report, `daemon_not_running` — or, in its
  place, `database_newer` when the database was migrated by a newer Caprock
  and no daemon of this version can open it (§ SQLite schema; the report's
  `schema_newer` then carries the refusal's text, absent otherwise).
  `other_install_holders` is said at level `ok`: its orphans are the
  `orphans` warning's, and the rest are sessions that outlived an upgrade.
  One `{level: "ok", code: "ok"}` stands in when nothing warns. The
  thresholds are round numbers chosen to say "worth a look", not measured
  limits.
- **`actions`** is what the daemon did about its footprint on its own,
  oldest first, the last 50 since it started, in memory only: every reap
  (§ Resources: on its own every 10 minutes, or from the button), every
  write-ahead-log checkpoint, every daily data-directory sweep that
  removed something ([02-architecture.md § Retention and
  cleanup](02-architecture.md#retention-and-cleanup)), and the database
  compaction — each run that replaced base64 in older events, the one
  VACUUM (or why it did not run or stopped), and each incremental vacuum
  that gave space back (§ Payload compaction and auto-vacuum). Every remedy
  that is safe to apply unattended is applied unattended — nobody else
  cleans up after a user's Caprock — and said here. Nothing is done on its
  own about another daemon, a second app or any process in `orphans` that
  is not a reapable holder (stopping a process Caprock did not start is the
  user's click, below — ADR-059), and no history is deleted (that is the
  user's call).
- **The WAL checkpoint.** Once a minute, on the I/O reading's tick, a WAL
  over 256 MiB is folded back with `PRAGMA wal_checkpoint(TRUNCATE)` — what
  SQLite's automatic checkpoint does in small steps, done at once and the
  file truncated after. A running read can hold part of it back; the next
  attempt is 10 minutes later. Below that, `journal_size_limit` (64 MiB, set
  when the database is opened) has SQLite truncate the WAL back after its own
  checkpoints, so a big transaction does not leave a large file behind.
- **A paired device may read it**, as it may read `/v1/resources`, orphans
  included; it may not stop one.
- **Who asks.** The dashboard's status strip, every 10 s while its page is
  visible (04-ui.md § Caprock footprint); each ask counts as looking, so
  the meter samples while it does. The panel's *Copy report* renders this
  object as `caprock doctor`'s text, and `testdata/footprint/doctor.json`
  with `doctor.txt` pin the two renderings to each other.

`POST /v1/footprint/orphans/stop` `{targets: [{pid, started_at}], force?}`
(1 to 256) → `{stopped: [orphan…], running: [orphan…], failed: [{pid,
error}]}`: the doctor's Clean up, row Stop and Force stop
([ADR-059](08-decisions.md), amended 2026-10-18). The daemon takes the
orphan list again and stops only a target that list holds with the same
`started_at`; anything else fails with *not on the doctor's list now*.
Each is sent one signal — SIGTERM, or SIGKILL when `force` is true
(Windows: TerminateProcess either way) — the start time checked again
before it (a pid whose start changed fails with *the process changed*), and
watched for 5 s: gone is `stopped`, still there is `running`, and nothing
more is sent. SIGKILL is only ever the user's second request, with `force`,
for one a stop reported `running`. Targets are stopped at once, in
parallel, and only the named pid is signalled, never its children. A pid of 1 or below or a missing `started_at` is a 400. Machine
only — on no paired device's list. Every stop is logged. It is never called
by the daemon itself, the orchestrator or an agent.

`caprock doctor [--json] [--data-dir <dir>] [--stop <pid>… [--yes] [--force]]` prints
the footprint as text — memory and CPU, disk, the daemon's disk I/O,
duplicates, orphans, what was done on its own, and the verdicts — or with
`--json` the object above, and exits
`1` when any verdict warns, `0` otherwise. With no daemon answering it
reports what it can read itself (`daemon_running: false`, no `disk_io`, no
CPU, no `actions`): the data directory's sizes and every Caprock process in
the process table with its memory; one daemon found there is not a
duplicate (it is the one that did not answer, or one for another data
directory). A daemon that answers but predates `/v1/footprint` gets the
same report with its own memory filled in, and the doctor takes the orphan
list itself (no sessions to check, so a `claude` is judged by its parent
alone; `note` says so). `--stop <pid>` (repeatable) shows each process from
the list just taken and asks `[y/N]` (`--yes` skips the question), then
stops it through the endpoint above — or, with no daemon (or one without
the endpoint), itself, by the same rule against its own scan; a pid not on
the list is refused. One still `running` after SIGTERM is printed with the
command that finishes it, `caprock doctor --stop <pid> --force` (SIGKILL);
the exit status is `1` when any was not stopped or is still running. The
Orphans section's heading carries the count and memory, *Orphans: 3 · 410 MB
(processes that look abandoned)*, and each process its CPU (once there is a
rate) and a `$ <cmd>` line.
User docs:
[docs/doctor.md](../docs/doctor.md).

#### Keep awake

`GET /v1/keepawake` (2026-10-11, [ADR-049](08-decisions.md)) says whether the
daemon is keeping the computer from idle-sleeping. Code:
`internal/keepawake` (the modes, the keeper, the per-OS holders) and
`internal/daemon/keepawake.go` (what counts as working).

```json
{"mode": "working", "holding": true, "since": 1791400000000, "working": 2,
 "available": true, "reason": "", "error": ""}
```

- `mode` is the effective mode: `off`, `working` or `always`.
- `holding` is true while the assertion is in force; `since` is when it was
  taken (Unix ms, absent when not holding). `working` is how many sessions
  counted as working at the last check, every 15 s.
- `available` is false where the machine offers nothing to ask (Linux without
  `systemd-inhibit`, a daemon built without a holder); `reason` says why.
- `error` is why the last attempt to hold failed, empty when it did not; a
  failed hold is tried again after five minutes.
- `501` when the daemon has no keeper. Machine only: not on a paired device's
  list.

`GET`/`PUT /v1/settings` carry **`keep_awake`**: one of `off`, `working`,
`always`, else `400` (an empty string included). `GET` returns the effective
mode, `working` when never chosen; it is stored as `keep_awake` in
`config.json` only once it differs from what is stored, so writing back what
was read does not pin the default.

`GET`/`PUT /v1/settings` carry **`worktree_cleanup`**: one of `off`, `ask`,
`auto`, else `400` (an empty string included). `GET` returns the effective
mode, `ask` when never chosen; stored as `worktree_cleanup` in `config.json`
the same way as `keep_awake`. A change checks every project with copies
again (§ Projects and shells, *Finished copies*).

`GET`/`PUT /v1/settings` carry **`end_idle_after`**: one of `2h`, `12h`,
`24h`, `never`, else `400` (an empty string included). `GET` returns the
effective choice, `12h` when never chosen; stored as `end_idle_after` in
`config.json` the same way as `keep_awake`. It is the idle window of
§ Ending idle sessions; `never` ends nothing.

`GET`/`PUT /v1/settings` carry **`statusline_mode`**: one of `full`,
`short`, `hidden`, `off`, else `400` (an empty string included). `GET` returns the
effective mode, `full` when never chosen; stored as `statusline_mode` in
`config.json` the same way as `keep_awake`. A change applies Caprock's own
`statusLine` entry to match (§ Statusline, *Settings → Status line*).

`GET`/`PUT /v1/settings` carry **`app_update`**: what the desktop app does
when the release check finds a newer version, one of `ask` (the update card;
nothing installs until a click) or `auto` (download and verify in the
background, install once it is safe to restart), else `400` (an empty string
included). `GET` returns the effective mode, `ask` when never chosen; stored
as `app_update` in `config.json` the same way as `keep_awake`. Only the app's
page acts on it; the daemon never installs anything (ADR-042 as amended
2026-10-15). Choosing `auto` in the app also sends `update_checks: true`.

`PUT /v1/settings` also accepts `gemini_api_key`, write-only and stored in `config.json` (unlike the two credentials below, which the secret store keeps). `GET` reports `gemini_key_set` and `gemini_key_from_env` instead of the value; `GEMINI_API_KEY` in the daemon's environment takes precedence over the stored key when both exist ([ADR-025](08-decisions.md)).

`PUT /v1/settings` also accepts `deepseek_api_key`, the user's DeepSeek key for Claude Code on DeepSeek (see **Subscriptions** below), write-only and kept in the secret store (below), never in `config.json`. `GET` reports `deepseek_key_set`, `deepseek_key_where` and `deepseek_key_hint` — the first three and last four characters (`sk-…1a2b`), or `…` for a key under 16 characters — never the value. Trimmed on the way in; `""` clears it; `400` for a value with a line break or a NUL, or over 512 bytes, because it becomes one environment variable of a child process. Caprock never sends it anywhere and never logs it.

`PUT /v1/settings` accepts `report_bot_token` and `report_chat_id` for the weekly report. The **token is write-only**: it is kept in the secret store (below) and never returned by `GET /v1/settings`, which instead carries `report_bot_set` (a bool), `report_bot_where`, `report_last_error` and `report_last_sent_ms`. This is the only write-only field in the API and it exists because the settings response is read on every dashboard render and by `caprock report` — a credential should not ride along on either ([ADR-024](08-decisions.md)). Omitting `report_bot_token` from a PUT leaves the stored one alone, since a UI that reads settings and writes them back always omits it; sending `""` clears it. The chat id is not a credential and round-trips normally. `report_last_error` is the last send's failure, kept in `meta` so it survives a restart; a send that goes through (scheduled or *Send one now*) clears it, and so does saving a different bot token or chat — through `PUT /v1/settings`, `PUT /v1/telegram/token` or pairing — because the failure was the old bot's (a stale *Unauthorized* sat under a fresh *sent — check Telegram*, owner, 2026-10-22). The Weekly report panel reads settings again after *Send one now*, whichever way it went.

**The secret store** (`internal/secret`, [ADR-024](08-decisions.md) amended
2026-10-14). The DeepSeek key and the Telegram bot token are kept as the
GitHub token is (§ GitHub, "Where the token lives"):

- **macOS:** the login keychain through `/usr/bin/security`, the keychain
  file always named. Services `dev.caprock.deepseek` and
  `dev.caprock.telegram`, account `caprock`.
- **Windows, Linux, or a keychain that refuses:** `<data_dir>/deepseek-api-key`
  and `<data_dir>/telegram-bot-token`, mode `0600`.
  `CAPROCK_SECRET_STORE=file` forces the files.
- **`config.json`** holds only `deepseek_key_stored` and `report_bot_stored`
  (bools), so a daemon that never stored one never asks the keychain. The old
  keys `deepseek_api_key` and `report_bot_token` are read once at start, moved
  to the store, and removed from the file in one atomic write; a store that
  refuses leaves them there, still used, and `*_where` says `config`.
- **`deepseek_key_where` / `report_bot_where`** (absent when none is set):
  `{kind: "keychain" | "file" | "config", path?, note?}`; `path` is the file's
  for `file` and `config`, `note` why the keychain was not used.
- **When it is read.** The DeepSeek key from the store when a session on it
  starts, into that session's environment only; the bot token at start, kept
  in memory for sends. Neither is logged. Clearing either (`""`, or the
  Telegram bridge's Disconnect) deletes it from the store.

`PUT /v1/settings` accepts `default_folder` (2026-10-09): where the app's Add project sheet starts — its folder field, a new project's parent, a clone's destination and the folder browser. Empty is the home folder; otherwise an absolute path or one led by `~`, one line, at most 1024 bytes (`400` otherwise). Stored as `default_folder` in `config.json` and returned by `GET`. It changes no boundary: `/v1/browse` and `/v1/browse/stat` stay rooted at `browse_root`.

`GET`/`PUT /v1/settings` carry `quick_replies` (2026-10-15): `[{label, text}]`, the one-click replies under a session Caprock started ([21-app.md § Quick replies](21-app.md#quick-replies)). `GET` returns the list in use — `config.DefaultQuickReplies` until changed. `PUT` replaces the whole list; absent or `null` leaves it. Each label and text is trimmed; at most 10 replies, a label of 1–24 characters on one line, a text of 1–300 bytes with no control character but a newline; anything else is a `400` and nothing changes. Stored in `config.json` only once it differs from the list in use, so writing back what was read never freezes the defaults; an empty list is kept as empty. A paired device does not write it. The `PUT` body may be up to 16 KiB (4 KiB before).

`GET`/`PUT /v1/settings` carry `prompts` (2026-10-09): when each of the dashboard's own offers was last answered, a map of prompt id → Unix ms, stored in `config.json` so an answer given in the desktop app holds in a browser tab too ([04-ui.md § Product-led surfaces](04-ui.md#product-led-surfaces)). Ids in use: `star-done`, `star-dismissed`, `premium-limit`, `premium-cap`, `premium-hint`, `premium-banner`, `teams-nudge`, `share-week`, `share-month`, and the offer survey's (`offer-variant-ads`, `offer-variant-youtube`, `offer-last`, and `offer-<id>-no`, `-sent`, `-seen-1`, `-seen-2` per offer; ADR-062). `PUT` **merges**: each named id keeps the later of its stored time and the new one, `0` removes it, ids not named are untouched. An id must be `a-z`, `0-9` and `-`, at most 40 bytes; a negative time or more than 64 ids is a `400`. Absent from `GET` when empty. A paired device does not write it; its answers stay in its own browser.

`GET /v1/team-signal` (2026-10-09) → `{authors, repos, window_days, checked_ms}`: how many distinct people committed to the listed repositories in the last 30 days, for the Caprock for Teams card (shown at `authors ≥ 2`). Read with `git log --all --no-merges --since=30.days.ago --format=%an%x09%ae` in at most 25 repositories, 2000 commits each, under the projects' git timeout; people are counted by lower-cased author name (one person, two addresses is one), bot authors left out; a repository whose git fails is skipped. Cached for six hours in the projects service. Counts only — no name or address leaves `internal/projects/authors.go` — and nothing leaves the machine. Not on a paired device's read list. `501` without the projects service.

`GET /v1/repos/activity` (2026-10-13) → `ReposActivity` `{repos[], github_connected}`: the Now screen's Repos section ([04-ui.md § Repos on Now](04-ui.md#repos-on-now)), asked only while that section is unfolded and the window visible. A row per listed project of kind `repo` (at most 12, in the sidebar's order) with a session that has not ended in it — the session's `repo_root`, else its `cwd`, at or below the project's root, so an agent's worktree under it counts:

- **Local** — `projects.RepoActivity` `{root, name, branch?, days[], commits[], added[], deleted[], lines_partial?, last_commit_at?, dirty, checked_ms, error?}` and `project_id`, `sessions`. Over the 14 local calendar days ending today, per day: the commits from `git log --all --no-merges -n 5000 --since=<first midnight> --format=%x1e%H %ct` (no diffs), and their lines from `git log --no-walk=unsorted --format=%x1e%H --shortstat <hash…>` in batches of 100 (`projects.parseRecords`, CRLF read like LF). A commit's lines are kept with the root's answer and never diffed again; the diffing runs under its own budget of 10 s a read (`activityLineBudget`), and when it runs out the batches done are kept, `lines_partial` is set and the answer is kept one minute instead of ten, so the next read goes on. One pass with `--shortstat` took 12 s on a checkout with 961 refs and 1,048 commits in 14 days (2026-10-17), past the git timeout, and the row read *git could not be read*. `branch` is `git branch --show-current` (absent when detached), `dirty` the lines of `git status --porcelain=v1`. Listing, branch and status run under the projects' git timeout — finished even when the request that started it is cancelled — and the answer is kept 10 minutes per root (64 roots at most), a failure to list the commits too (`error`, the arrays zero).
- **GitHub** — `github?` `{repo, pulls?, ci?, release?}` only while GitHub is connected and the remote (read through the repository cache, else the project's `remote_url`) is on GitHub; each part only from an answer Caprock already keeps, however old — this route sends GitHub nothing. `pulls` `{open, merged_7d, ttm_median_ms?, listed}` from the last pull request list the Branches view or the Pipeline read (`github.CachedRepoPulls`); `ci` `{runs, red, workflow?, median_ms?, last?}` is `github.RunStats` over the last runs list the Pipeline read (`github.CachedRepoRuns`, 14 days, the workflow taking the most time first), `last` `{name, branch?, status, conclusion?, at?, url?}` the run of that list created last (`at` its `updated_at`); `release` `{tag?, state, at?}` from the deck's last Release answer (`github.CachedRelease`; absent with no release run). A part nobody read yet is absent.

On a paired device's read list (counts only). `501` without the projects service.

`GET /v1/repos/ci[?older=1][&hide=owner/name,…]` (2026-10-14) → `ReposCI` `{github_connected, status?, repos[], quiet[], recent_days, fetched_at, refreshing?}`: the Now screen's CI/CD section ([04-ui.md § CI/CD on Now](04-ui.md#cicd-on-now)), asked only while that section is unfolded and the window visible (every 2 minutes). Nothing is sent and `repos` is empty while GitHub is not connected. The rows are the listed projects of kind `repo` whose remote is on GitHub, and each member repository of a multi-repo project on GitHub (2026-10-18, ADR-077: `project_id` its project, `name` "project · repository"), one per GitHub repository, with activity in the last `recent_days` (14: a session's last event in the repository, or the project's `added_at`), those with a session running first, then by `last_active`, at most 6 (`reposCIMax`); with `older=1` the older ones too, marked `older`, at most 12 in all (`reposCIOlderMax`). A repository named in `hide` (this viewer's hidden ones, case-insensitive, at most 200), one without recent activity while `older` is not asked, and one past the bound are listed in `quiet[]` `{project_id, name, repo, last_active?, why: older|hidden|more}` and nothing is sent to GitHub for them. Each row is read through the kept GitHub reads the Pipeline makes — the pull request list (2 min), the runs list (`github.RepoRuns`) and the releases list (`github.RepoReleases`, below) — so a repository costs GitHub at most those three conditional reads per keep. Rows are read at most 3 at once (`reposCIParallel`), each within 12 s (`reposCIRepoTimeout`), the status page beside them, the whole within 30 s; a row GitHub did not answer in time carries `slow: true` beside its `error`. A row also carries `last_active` (Unix ms), `read_at` (Unix ms, when GitHub last answered its pull request list; with `error`, the row draws on that older read) and, in the quick answer, `pending`. The answer carries `refresh_error` and `refresh_failed_at` as the deck's do. The composed answer is kept as the deck's are (`deckcache.go`, key `reposci` with `older` and the sorted `hide`); a key never composed is answered at once with the rows unread (`pending`, `refreshing`) while the composition goes on. Each `top_prs[]` entry adds `shared` (sessions charged only in part) and `tokens_in`, `tokens_out`, `cache_read`, `cache_write` (`store.PRSpend`, below).

- **Row** — `RepoCIRow` `{project_id, name, repo, live, ci?, days?, stuck[], open, merged_7d, top_prs[], authors[], release?, error?}`. `live` counts the sessions not ended under the project's root; `ci` is `github.RunStats` over the runs, 14 days (the `CIStats` of `…/ci/stats`), `days` its local calendar days; `open` and `merged_7d` count the listed pull requests; `release` is the newest published release (`RepoRelease`); a failed list is `error` with the rest absent.
- **Stuck** — `github.StuckRuns`: `{id, name, branch?, status, url?, since, median_ms?}` for a run `in_progress` longer than twice its workflow's median successful run over the 14 days and at least 10 minutes over it (no median, never), or waiting for a runner (`queued`, `waiting`, `pending`, `requested`) longer than 15 minutes; `since` is `run_started_at`, else `created_at`. The runs list is kept 2 minutes instead of 30 while any run in it is unfinished (`repoRunsActiveKept`), so a stuck run is seen within minutes; a conditional read costs a 304 when nothing changed.
- **Cost per pull request** — `top_prs` `{number, title?, url, state, draft?, author?, author_avatar?, cost_usd, sessions, live}`: the open pull requests and those merged in the last 7 days, charged with `store.SpendByPR` (§ Pull request spend, below), the 5 with the highest `cost_usd` above 0. `authors` `{login, avatar?, prs, merged, cost_usd}`: who opened those same pull requests (GitHub's `user.login` and `avatar_url`), by `cost_usd`, then `prs`.
- **GitHub's status** — `status` `{indicator, description, components[{name, status}], incidents[{name, impact?, status?, url?}], at, error?}` from `GET https://www.githubstatus.com/api/v2/summary.json` (`github.StatusPage`), only while GitHub is connected, kept 5 minutes, sent with no token, cookie or anything about the user. `components` are those not `operational` plus Actions, Pull Requests, API Requests and Git Operations whatever their state; `incidents` the unresolved ones. A failed read keeps the last answer with `error` set and is not retried for 5 minutes. `Service.StatusURL` replaces the address (tests).

On a paired device's read list. `501` without the projects service.

`GET /v1/repos/remotes?dir=…&dir=…` (2026-10-15) → `ReposRemotes` `{repos[]}`: the Pipeline's repository picker ([04-ui.md § CI on the Pipeline and in the cockpit, and Investigate](04-ui.md#ci-on-the-pipeline-and-in-the-cockpit-and-investigate)) asks which of the folders agent sessions worked in are git repositories with a GitHub remote. One `RepoRemote` `{dir, root?, repo?, guarded?}` per distinct non-empty `dir`, in the order asked, at most 100 (`reposRemotesMax`): `root` is the repository's top level (absent outside git), `repo` is owner/name when its remote is on GitHub (`github.ParseRemote`; absent with no remote or another host). A folder macOS guards (`tcc.Guarded`: Documents, Downloads, Desktop…) is never read here and answers `guarded: true` alone, so opening the Pipeline asks for no folder access. Read through the session page's `repoCache` (one minute per folder), at most 8 folders at once; nothing is sent anywhere. Nothing asked answers `{"repos":[]}`. On a paired device's read list.

**Pull request spend** (`store.SpendByPR`, 2026-10-14) charges recorded agent work to pull requests, at API list price, each session through one way only so the figures add up to what the sessions cost and never more (rule 6). A session on a pull request's head branch (`sessions.git_branch`, `repo_root` the repository's) is charged to it whole, unless it opened or merged more than one pull request (`session_prs` rows with `opened_at` or `merged_at`): `git_branch` is the branch a session was on last, and a long session that drove hundreds of pull requests and ended on a release branch was charged whole to the release's pull request (#601 read as $1,884.29, the session's entire spend; cut as below it is $2.12, measured on the owner's database 2026-10-14). Where two pull requests share a head branch the open one owns it, else the most recently updated. A session not charged by its branch that recorded pull requests in `session_prs` is cut at them: ordered by `opened_at` (else `last_at`), each is charged the session's `events.cost_usd` (`internal = 0`) after the previous one's moment up to its own, and the newest also everything after it; a session with one pull request is charged its `session_stats.cost_usd` whole. `PRSpend` `{cost_usd, sessions, live, agents[], by_branch, by_slice, shared?, tokens_in, tokens_out, cache_read, cache_write}`: the tokens are the same work's (`session_stats` for a whole session, the slice's `events` sums for a cut one), `shared` counts the cut sessions: `live` counts sessions not ended — for a cut session only on its newest pull request. Three reads: the repository's sessions with a branch (`idx_sessions_repo_branch`), the `session_prs` rows of the sessions that recorded one of the pull requests, and one sum per slice over a session's events (`(session_id, ts)` index). 18–57 ms warm and 105 ms cold for 49 pull requests on a 2.3 GB copy of the owner's database (2026-10-14), one session holding 308 of them.

**Phone alerts** ([ADR-036](08-decisions.md)) go through the same bot and are
free: no licence is checked. `PUT /v1/settings` accepts `alert_approval` and
`alert_finished` (bools, both off unless turned on, stored as pointers in
`config.json` so "never set" means off) and `alert_reply` (on unless turned off, for the
first line of the final reply in a finished alert) and `alert_done` (on unless
turned off: a turn that asked nothing still goes as *Finished*, § Needs you and
Done); `GET` returns them with
`alert_last_error` and `alert_last_sent_ms`, held in memory since the daemon
started, and `alert_untested` (read-only): a bot token or a different chat was
saved — through `PUT /v1/telegram/token`, pairing, or `PUT /v1/settings` —
since the last alert was tried. Such a save forgets the error and the time,
which were the old bot's or chat's; the next alert or test ends it. Nothing is sent until a bot token and chat id are set. The rules, in
`internal/alerts` over every stored event from every source:

- **Waiting for approval** — a `permission.prompt` sends at once, once per
  dialog; the dialog is over at the session's next later event or `Stop`.
- **Finished** — a main-thread `agent.stop`, or a `throttle` (StopFailure),
  sends after a minute with no later event in the session. Only hooks record
  either today, so this is Claude Code's; Codex and OpenCode report no turn
  end or approval.
- **No spam** — at most one alert of a kind per session in 3 minutes, and 20 in
  any hour across all sessions; the twentieth says the rest are held. An event
  more than 2 minutes old pages nobody, so a transcript re-read after a restart
  stays quiet. A failed send is logged and shown, never retried.

The message is sent with `parse_mode: HTML`, every string from a session
escaped (`&`, `<`, `>`). Its first line says whose it is: the agent's mark and
name, the project and the session's name as Now shows it (`🟠 Claude Code ·
caprock · Fix the cache test`; marks: Claude Code 🟠, Codex ⚪, OpenCode ⚫,
Gemini CLI 🔵, DeepSeek Harness 🐋, Grok Build ⬛, Hermes Agent 🪽) ([ADR-047](08-decisions.md)).
The second is the status (`✅ Finished`, `⚠️ Stopped: <error>`, `⏳ Needs
approval`, `❓ Needs your answer`); then the folder with home as `~` and the
branch; for a dialog the tool and its command, file, URL or question (100
characters), led by `Subagent (<type>)` when a subagent asks; for a finished
run — since the last main-thread prompt — its duration, cost, tool calls and
changed files (`Edit`/`Write`/`MultiEdit`/`NotebookEdit` paths, three named),
and while `alert_reply` is on the first line of the final reply (the Stop
hook's `last_assistant_message`, else the newest main-thread prose; 120
characters); last, a link to `#/session/<id>` on the address phone access
listens on — the LAN or Tailscale one — omitted when phone access is off. Code,
diffs and tool output are never sent (ADR-036, amended 2026-10-05), except as
§ Telegram bridge below allows. Under the message: **Open on phone** (a URL
button, when the link exists; a message Telegram refuses for its address is
sent again without it) and **Mute this session**; with two-way chat active,
**Approve** and **Deny** under a dialog in a session Caprock started whose
prompt is the only one outstanding (ADR-035).
The same decisions reach the desktop app as `notify` frames, under the same rules and caps, with switches of their own (§ Notify frame).
`CAPROCK_TELEGRAM_API` in the daemon's environment replaces
`https://api.telegram.org` for every Telegram call, to test against a stub.

#### Telegram bridge

[ADR-047](08-decisions.md). The bot set up for the alerts also reads what its
one paired chat sends back. Routes, all machine-only (none is on a paired
device's list), all answering the status below:

```
GET    /v1/telegram           → TelegramStatus
PUT    /v1/telegram/token     {token} → checked with getMe, stored only when Telegram knows it; 400 with Telegram's reason otherwise
POST   /v1/telegram/pair      → a new one-time code (10 minutes); 409 with no bot
DELETE /v1/telegram/pair      → the code withdrawn
DELETE /v1/telegram           → token, chat and telegram.json forgotten (the weekly report and alerts stop too)
POST   /v1/telegram/photo     {png, caption} → {sent:true}; 409 with no bot or chat, 400 when png is not one base64 PNG ≤ 10 MB, 502 with Telegram's words
```

`POST /v1/telegram/photo` is the Share sheet's **Send to my Telegram** (§ Share in
04-ui.md): `png` is a share card, base64 (JSON, not multipart, because every
state-changing route is `application/json`, csrf.go), and `caption` plain
text, cut to Telegram's 1024 characters. It is sent at once with `sendPhoto`
to the paired chat — not through the alert outbox, and needing no alert kind
or two-way chat on, only a bot and a chat — and only because the person
clicked. Nothing is stored. The card and the caption are anonymous unless the
person ticked **Show repo name** for that one share (04-ui.md § Share).

`TelegramStatus` = `{bot_set, token_masked?, bot_username?, chat_set,
chat_name?, manual_chat?, pairing?: {code, link?, expires_ms}, polling,
last_error?, mute_all?, muted?}`. `token_masked` is `••••••` and the token's
last four characters; the token itself is never in a response, a log line or
an error (a transport error's URL, which carries it, is dropped). `link` is
`https://t.me/<bot>?start=<code>`, which opens the bot and sends `/start
<code>` in one tap. `manual_chat` marks a chat id typed in before pairing
existed; it keeps working.

- **Pairing.** The first message from a **private** chat that is `/start
  <code>`, `/start@bot <code>` or the six digits alone, while the code is
  valid, pairs that chat: its id is stored as `report_chat_id`. A wrong code
  is answered "does not match" (five end the pairing); a group is refused.
- **Reading.** `getUpdates` long polling (25 s), only while pairing, or while
  a chat is paired and an alert kind or two-way chat is on. Nothing listens
  for Telegram. The next offset is kept in `telegram.json`. Failures back off
  from 1 s to a minute; a refused token stops reading until a new one is
  saved. A message from any other chat is dropped unanswered; one dated more
  than two minutes before reading began is skipped.
- **Free** (no licence): `/help`, `/start`, `/mute` (as a reply, `/mute <n>`,
  `/mute all` or bare), `/unmute`, and the Mute button.
- **Premium** — an active licence **and** `telegram_chat` on: a reply to one
  of the bot's messages types its text into that session and presses Enter
  as the message queue does (§ Queued messages: a paste where the session
  takes one, the Enter on its own after a pause, once more if the prompt
  still holds the text), only for a session Caprock
  started and is running; a session it did not start gets "I can only watch
  this one", one waiting on a permission prompt gets "answer that first".
  `/sessions` lists up to 20 live sessions with their header and state,
  numbered, with a button per running owned one that asks for a reply to it.
  `/new <project> <message>` starts Claude Code in the project of that name
  (exact, else the only prefix, else the only substring match) in
  `spawn_permission_mode`; Bypass asks first (*Start in Bypass* / *Ask first
  instead* / *Cancel*) and still needs the one-time consent of ADR-041.
  `/stop <n>` (or as a reply) asks, then kills a session Caprock started.
  Approve and Deny call the same answer path as the card (`AnswerPermission`:
  the key read off the screen, `422` cases toasted, nothing typed blind); the
  buttons are replaced by the outcome. Without a licence or with the switch
  off, the chat gets one line saying so at most once a day; a button gets a
  toast.
- **Conversations.** A session typed into from Telegram, or started there,
  answers there for an hour after: its permission prompts are sent at once
  (with Approve and Deny), and its reply the moment its turn ends — the Stop
  hook's `last_assistant_message`, up to 3,000 characters, `inline code` and
  `**bold**` kept, each fenced block replaced by `[<lang>, N lines]` unless
  `telegram_code` is on (then `<pre>`). The rules' own alerts skip it meanwhile.
  With two-way chat active, finished alerts carry the reply the same way.
- **Forwards** (Premium, [ADR-081](08-decisions.md)). A forwarded message
  (`forward_origin`), or a photo, document, voice note, audio or video sent
  in the paired chat, is gathered until the chat has been quiet for 2 s
  (`media_group_id` albums arrive the same way); plain text typed during
  that, just before it, or while the question is open is the owner's words,
  put first. The bot then sends one *Where to? (N messages, N photos…)* with
  a button per session (`f:<n>`): Caprock's own and running, not chats,
  waiting first, then working, then the rest by last activity, quiet ones
  for 48 h only, at most 6, each *● name · waiting | working | 2h ago*; then
  *+ New chat* (`f:n`; Bypass asks `f:nb` / `f:nd`), *Cancel* (`f:x`) and
  *Reply here: off|on* (`f:r`, remembered as `forward_reply`). A tap sends
  one message — the words, then each item as `> Forwarded from <name>` (or
  `> Forwarded message`) and its text or caption as quoted lines; a photo,
  file or voice note fetched with `getFile` and `/file/bot<token>/<path>`
  (10 MB at most) into `<data_dir>/paste/<stamp>-<hex>/` with the paste
  checks, voice and audio (`ogg`, `oga`, `opus`, `mp3`, `m4a`, `wav`) also
  allowed, named by its quoted path; a voice note as *Voice message (not
  transcribed)* — at most 16 KiB — through the message queue with `via:
  "telegram"`. The question is edited (`editMessageText`) to *✓ Sent to
  <name>*, or *⏳ <name> is busy — will send when it finishes* and *✓ Sent*
  when the queue types it in. *+ New chat* starts `{chat: true}` with it as
  the first message. With *Reply here* on, that turn's Stop sends its reply
  as a conversation does, and the finished alert about it is held back.
  A question is good for 10 minutes and one answer.
- **Pace.** One message per second to the chat; a 429's `retry_after` is
  waited out up to 10 s and holds the queue for longer ones; with more than
  three plain messages waiting they are joined into one; an alert not sent
  within 30 s is dropped.

`PUT /v1/settings` accepts `telegram_chat` and `telegram_code` (bools, off
unless turned on; `GET` returns them). `<data_dir>/telegram.json` (`0600`) is
the bridge's own: `{bot_id, bot_username, chat_id, chat_name, paired_at,
offset, refs: [{message_id, session_id, prompt_id, kind, at, module,
buttons, order, chosen, answers}], muted: {session_id: ms}, mute_all,
premium_note_at, module_pins: {module_id: message_id}, forward_reply}` — the last 400 messages and the sessions (or
private modules) they were about, so a reply finds its session, and a module
its own message, across a restart. The
token stays in `config.json`.

`GET /v1/gemini` reports whether asking Gemini is possible here: `{available, env_var, licensed, model}`. It performs **no network I/O** and **never returns the key** — `available` says only that one is present. `POST /v1/gemini/ask` takes `{prompt, model?}` and answers `{text, model, usage}`, where `usage` carries the response's own `promptTokenCount` / `candidatesTokenCount` / `cachedContentTokenCount` / `thoughtsTokenCount`. It is the one endpoint in the product that checks the licence **server-side** (402 without an active key) rather than leaving the paywall to the UI, because the call spends the user's Gemini quota and opens an outbound connection — the reasoning and its limits are in [ADR-023](08-decisions.md). With no key set it answers 412 with the variable to set, which is a different problem from 402 and is reported separately so the screen can say which. The key is read from `GEMINI_API_KEY` in the daemon's environment at call time; it is never stored, never accepted by `PUT /v1/settings`, and never present in `GET /v1/settings`.

`POST /v1/claude/bypass-consent` writes `skipDangerousModePermissionPrompt: true` into the settings file `/v1/status.hooks.settings_path` names — the key Claude Code itself writes when its one-time bypass warning is answered *Yes, I accept* — backing the file up once and keeping every other key in place and order; an unparsable file is refused, never overwritten. A mutating route: cross-site requests and paired devices are refused, so the consent is given at the machine. `/v1/status.claude_bypass_accepted` reports the key. `POST /v1/agents` for a Claude Code session in `bypassPermissions` (asked for, or filled in from the preference or a continued session's mode) on a machine where it is false answers **409** `{error, code: "bypass_consent"}` and starts nothing: the session would open on Claude Code's warning, whose default answer is *No, exit*. Another agent, another mode and a terminal `command` are never refused; an unreadable settings file is not a refusal (ADR-041).

`POST /v1/hooks/install` runs the same install as `caprock hooks install` (`hooks.InstallFor`: copy the shim into the data dir, merge Caprock's entries into the settings file this daemon reports in `/v1/status.hooks.settings_path`, backing it up first) and answers with what is registered afterwards (`{hooks: {settings_path, shim_path, installed, missing, shim_exists}, backup?}`); an error is an error status, never a quiet 200, and a daemon without an installer answers 501. It is a mutating route, so the CSRF guard refuses a cross-site request and a paired device cannot make it. Nothing else in settings.json is touched. `/v1/status.hooks`, `caprock status` and this answer all check against the command an install writes (`hooks.StatusFor`): the shim in the data dir, or the fallback `"<exe>" hook` when none sits beside the binary. Checking against the shim path alone recognised that fallback only for an executable named `caprock`, so on a renamed or preview build the button said installed and the next status said all nine were missing.

**Offer survey** ([ADR-062](08-decisions.md)). `POST /v1/offer {offer, answers, email?}` is the one route that sends what the user chose to Caprock, and the dashboard calls it only from the survey card's **Send** button. `offer` is one of the dashboard's surveys, and `answers` is exactly `{q1, q2}`, each one allowed value: `ads` and `youtube` — `q1` `under-4`, `4-8`, `8-12`, `12+`; `q2` `under-30`, `30-70`, `over-70`. `local-models` — `q1` `coding`, `chat`, `search`, `trying`; `q2` `mac-16`, `mac-24-64`, `mac-96`, `pc-nvidia`, `other`. `email`, when present, is one plain address of at most 254 characters. Anything else is `400` and nothing is sent. The daemon rebuilds the body from those fields alone and POSTs `{offer, answers, email?}` — no version, no identifier — to `https://caprock.dev/api/offer` with a 10 s limit; `CAPROCK_OFFER_URL` replaces the address for a preview stand or a test, which must never reach the real site. `200 {status: "sent"}` when the site took it, `502 {error}` when it did not — the error never carries the email or the address. Machine-only: a paired device gets `403` like every write. The enums live in `internal/api/offer.go`, `ui/src/lib/offer.ts` and the site's `functions/api/offer.ts`, and change together. What keeps a card away is ordinary `settings.prompts` entries: the draw (`offer-variant-ads` or `offer-variant-youtube`), the day any offer last showed (`offer-last`), and per offer `offer-<id>-no`, `-sent`, `-seen-1`, `-seen-2`.

**Report a bug** ([ADR-073](08-decisions.md)). `POST /v1/support {text,
email?, screenshots?}` forwards one bug report to Caprock support, and the
dashboard calls it only from the sheet's **Send to support** button
(`components/BugReportSheet.tsx`). `text` is 1 to 8,000 characters (Unicode
code points, valid UTF-8, not only whitespace), forwarded as typed. `email`,
when present, is one plain address of at most 254 characters, trimmed.
`screenshots` is at most 3 of `{name, type, data}`: `type` is `image/png`,
`image/jpeg` or `image/webp` and must match the data's first bytes, `data` is
standard base64 of at most 4 MB decoded, all of them at most 8 MB together,
and `name` is at most 200 bytes, cut to the file's own name (anything up to the
last `/` or `\` dropped). The body is read up to 12 MB. Anything else is
`400 {error}` and nothing is sent. The daemon rebuilds the body from those
fields and adds two of its own, then POSTs to `https://caprock.dev/api/support`
with a 20 s limit:

```json
{"text": "…", "email": "me@example.com", "screenshots": [{"name": "shot.jpg", "type": "image/jpeg", "data": "<base64>"}], "version": "<caprock version>", "os": "darwin/arm64"}
```

`email` and `screenshots` are left out when absent; `os` is `GOOS/GOARCH`. No
identifier, path, transcript or log. `CAPROCK_SUPPORT_URL` replaces the
address for a preview stand or a test, which must never reach the real site.
`200 {ok: true}` when the site answered 2xx, `502 {error}` when it did not —
the error never carries the text, the email or the address. Nothing is
retried and nothing is queued; the handler logs none of the report. The
machine and a paired controller may send one; a viewer gets `403`.

`GET /v1/update` returns `{enabled, current, latest, update_available, command, app_command, url, checked_at, error, notes, notes_for}` from cache and **performs no network I/O** — a page load must never cause an outbound call. `POST /v1/update/check` performs one, and returns **403 while `update_checks` is false**: the opt-in is enforced by the server, not merely hidden in the UI, so no page or local script can make Caprock reach the network uninvited. Checks are throttled to once every 15 minutes unless forced (`update.Interval`; releases ship several times a day, hourly until 2026-10-16) — at startup, when the switch is turned on, and on a five-minute tick that asks whether one is due (so a daemon that runs for weeks still hears of a release). `POST /v1/update/check?soon=1` is the page's ask when the window gains focus or is shown: not forced, it runs only when the last check is ten minutes old (`update.SoonInterval`) and otherwise returns the cached status; it shares the last-checked time with the tick, and an unforced check already out answers the next one, so unforced checks never run more than once per ten minutes. The interval is measured on the wall clock, because macOS stops the monotonic clock while the machine sleeps: a check that fell due overnight runs within five minutes of waking. After a failed check the next unforced one waits 15 minutes (`update.FailRetry`), so an offline laptop does not try on every tick. Each repeat is conditional: the request sends the last `ETag` as `If-None-Match`, and a `304` keeps the cached answer and counts as a successful check. The request carries no body or credentials, and a failure is reported in `error` rather than as an error status — not knowing about a release must not read as a broken dashboard. `command` is the upgrade command inferred from the running binary's path (Homebrew, Scoop, `go install`); when no package manager owns the binary it is empty and the UI offers `url` instead. `app_command` is `brew update && brew upgrade --cask caprock-app` when Homebrew's cask installed the desktop app on this machine (`<prefix>/Caskroom/caprock-app` exists, `/opt/homebrew` or `/usr/local`), set only beside `update_available`; the app shows it first and `command` second when both exist, because the cask and the formula are upgraded separately. `notes` is the published release's own description, taken from the same GitHub response as the tag — reading it costs no second request and no further exposure. It is trimmed to a dialog-sized excerpt (long bodies cut at a line boundary) and paired with `notes_for`, the version it describes, so a cached note can never be shown beside a different version after a failed check. `update_available` is never true for a `dev` or `git describe` build. The daemon does not install the update: replacing the running binary would mean the daemon killing the process executing the command, and running a package manager on the user's behalf from a web page is a surface a local tool should not open. The desktop app replaces its own bundle, which carries the daemon (ADR-042).

`GET /v1/update/busy` returns `{working}`: how many sessions are working now — mid-turn, with subagents still running, or waiting on a permission prompt — the count the keep-awake hold uses (ADR-049). The desktop app set to `app_update: auto` installs a downloaded update only while it is `0`. A read of the local database, no network I/O, nothing about the sessions but the count; a failed count is an error status, never a `0`. Not on a paired device's allowlist.

**`PUT /v1/settings` is a patch, not a replace.** Fields are decoded as pointers, so a body changes only the keys it names and leaves the rest as they were; `PUT {}` is a no-op. An explicit `false` is still honoured, so nothing here is write-only. This is not a convenience: decoding into a plain struct made an absent field indistinguishable from a cleared one, so a short body — or a retry that dropped fields — answered 200 while resetting the stated plan *and* switching the release-check opt-in off. The plan decides what every cost figure on the dashboard claims to be, and `update_checks` gates rule 4's single outbound call; neither may be toggled by omission.

`GET`/`PUT /v1/settings` carry `{plan_kind, plan_label, plan_usd_per_month}` — how the user pays for Claude Code. Caprock **cannot detect this and never guesses**: Claude Code does not report the plan, and inferring one from usage would be an invented number (rule 6), so the user states it and it is stored in `config.json` like every other setting. `plan_kind` is `""` (not stated), `"flat"` (Pro/Max/Team seat — usage at API list price is an *equivalent*, so comparing it to the fee is meaningful), or `"metered"` (API key, Bedrock, Vertex, or Enterprise usage billed at API rates — the API-list figure **is** approximately the bill, so it is never framed as a saving). `PUT` validates rather than coerces: an unknown `plan_kind` or a negative/non-finite price is a 400, because a typo would otherwise drive a wrong headline figure. Both return 501 when the daemon has no settings controller.

`SessionSummary` = the `sessions` row + `stats` (session_stats) + `activity` ({phrase, tool, at, health, plan, repeats, background, provisional, need} from `internal/narrate`; `need` beside health `waiting-on-you` or `done` — § Needs you and Done; `provisional` while a submit nudge, not an event, says working — § Nudges) + `savings` (cache math) + `loop` (active alert, if any) + `context` ({tokens, window, pct} — the main thread's last turn's prompt size vs that turn's model's context window from `pricing.json`; a subagent's turn is used only when the session has no main-thread turn at all, as in an OpenCode child session). When `context` is absent, **`context_note` says why**: `no turn yet` (the session has not answered, so there is no prompt to measure), `<id> not in pricing table` (naming the id, which is the one thing a user can report and we can fix), `unknown model`, or `no pricing table`. The reasons call for opposite reactions — one resolves itself in seconds, the other never will — and the client cannot tell them apart from the session row alone; captioning every empty Context "unknown model" put those words beside a Cost stat naming `claude-opus-5` in the same row. `SessionDetail` adds `files`, the last 60 `events`, `repo` and `prs` (see **Repository and pull-request links** under Phase 1 additions), and the relay chain: `relayed_from` (`{session_id, agent, title?, started_at}`, absent when none) and `relayed_to` (a list of the same, oldest first, `[]` when none). `?range=` on `/v1/stats/summary` accepts `today` (default), `7d`, `30d`, `all`, or a Go duration; ranges are calendar-aware in the daemon's local time zone. The summary carries `burn` ($/h and tokens/min over the last 10 minutes) and `pricing_version`. Each entry in `projects` is `{project, tokens, cost_usd, sessions, dir?, paths?}` — one row per **repository** (see § Repository grouping DDL), where `sessions` counts the distinct sessions that touched it in the range, so a per-repo roll-up can state both what a repo cost and how many sessions worked in it. `dir` is the directory the row is keyed on — the repository root, or the session's own directory for work outside any repository — and is absent only on the row for spend whose session was deleted. `GET /v1/sessions?dir=<dir>` lists exactly that row's sessions: an **exact** match on `repo_root`, plus sessions with no repository whose `cwd` is the directory — the same grouping the summary uses, never the free-text search (`?q=`), which also reads prompts and would pull in every session that mentioned the name. Each entry there carries `resume` for live sessions too, not only ended ones, because the caller (1-click terminal, see [04-ui.md](04-ui.md)) offers to open, continue or branch from the list; `resume` is `null` for a session Caprock holds the terminal of. `paths` is the per-directory breakdown: `{path, tokens, cost_usd, turns, unattributed?, outside?, tokens_pct, cost_pct}`, charged by **carry-forward** from the files the repository's turns touched rather than by the directory a session was launched from (see § Touch attribution DDL). Two entries are not directories and must be rendered as their own thing: `unattributed` (turns before their session touched any file) and `outside` (turns whose most recent touch was outside the repository); a bucket row that cost $0 is omitted. `path` is the full directory relative to the repository root, written from it (`/`, `/services/api`). It is **omitted for a repository with fewer than two rows**, which would merely restate the row's own total, and it always sums exactly to the parent row — the panel must never state two different totals for one repository (rule 6). `turns` replaces a session count because a session touches many directories while a turn is charged to exactly one, so turns partition and add up. `tokens_pct` and `cost_pct` are shares of the **repository total including the unattributed row**, so each column sums to 100% and the share nothing could be attributed to is visible as its own number rather than hidden in the denominator; both are sent because cost per token varies by model and the two genuinely differ. Each entry may also carry `spark` — `{from_ms, width_ms, cost[], tokens[], input[], turns[], active_hours[], active_cost[]}`, the row's spend over time, where bucket `i` covers `[from_ms + i*width_ms, from_ms + (i+1)*width_ms)`. All six are parallel arrays over the **same** buckets, from the same scan, so which one a picture plots stays a display choice rather than a request — changing the basis must never cost a round-trip on a polled endpoint. `tokens` is input plus output; `input` is the input side alone (fresh input, cache reads and cache writes — the cockpit's own *tokens*), and `turns` the assistant turns, the summary's own `turns` per bucket. `active_hours` counts the bucket's **active session-hours** — clock hours (from the grid's start, so an hour never straddles two buckets) in which one session made at least five priced calls costing more than nothing, the same rule as `usual.burn` — and `active_cost` what those hours cost, so `active_cost / active_hours` is the bucket's burn rate per hour actually worked, and a bucket with no active hour has no rate rather than $0/h; the scan groups by (session, bucket, hour) instead of (session, bucket), 0.032 s → 0.033 s warm for 30 days on a 2.3 GB copy of the owner's database (2026-10-13), off the same covering index. A daemon from before `input` and `turns` sends neither, and one from before `active_hours` and `active_cost` sends neither of those; a client draws that series as unknown, never as zeros. The Projects panel plots tokens; the cockpit's spend chart sums every row's series bucket by bucket and plots cost, burn rate, input or turns (see [04-ui.md](04-ui.md)). The grid follows the range and starts at the same calendar-aligned instant: `today` → 24 hourly buckets, `7d` → 7 daily, `30d` → 30 daily, a typed `<n>d` (n ≤ 90) → n daily. `spark` is **absent for `range=all`**, whose start is the first event ever captured — a fixed bucket count would make a column mean a different span on every machine. The columns sum to at most the row total and never more: spend inside the range but outside the bucket grid still counts toward the row, because dropping it would understate the bill (rule 6). `paths` entries carry no series — a sparkline per directory would multiply a polled payload for a picture hidden until the row is expanded. The summary also carries `work` and `work_unlinked_calls` — what the money was spent **on**, by the kind of work each turn did (see § Work attribution DDL).

**The session's `model` is its main thread's.** `sessions.model` is the model of the newest event from the session's main thread (`rollup.Record`); a subagent's event — `agent_id` set, or `payload.sidechain` true, the same test the notes query uses (`event.Event.Subagent`, `store.MainThreadWhere`) — fills it only while it is empty, through `SessionPatch.SubagentModel`. An Opus session whose Explore subagent runs on Haiku is an Opus session on its card, in every list and in the window its context fill is measured against; the subagent's turns are still priced by their own model and counted in `session_stats` and `daily_stats` (keyed by the turn's model) exactly as before. A session whose every turn is a subagent's (an OpenCode child session) is named by them. Earlier versions let a subagent's turn overwrite the column; `rollup.RepairSessionModels` sets each session's model once (`meta.session_model_repaired`) to that of its newest main-thread `turn.assistant` (by `ts`, internal turns excluded) where the stored value differs, and leaves sessions with no main-thread turn alone. Measured on a copy of the owner's database (2026-10-01): 6 of the 140 sessions with a main-thread turn were wrong, all six named after a subagent's model; the pass took 3.3 s on an 879 MB file, once, in the background after the port opens. The context badge looks for the main thread's last turn among the session's newest 5000 events when the newest 60 hold none (`store.LastMainTurn`, about 20 ms on a 51k-event session).

### A tool's calls, grouped (`GET /v1/tools/drill`)

```
GET  /v1/tools/drill?tool=Bash&range=today|7d|30d|all&agent=   → ToolDrill — one tool's calls grouped by what they were about
```

`tool` is required (400 without it, or longer than 200 bytes); `range` and
`agent` mean what they mean on `/v1/stats`. The response is
`{tool, kind, group_by, calls, rows[], other, range, locked}` plus the
Premium fields below:

- **Grouping** (`kind`, `group_by`): a shell tool (Bash, Codex's `exec`,
  `shell`, `exec_command`) by the command's head — the program, plus the
  subcommand for tools where it is the point (`git commit`, `go test`,
  `npm run`; `gh` keeps two words), with `cd`, `export` and other setup
  statements skipped; Read, Edit, Write, MultiEdit and the notebook tools by
  file, shown relative to the home directory; WebFetch by domain; WebSearch
  by query; an MCP tool by its `action` input; any other tool by subagent
  type (Task), pattern (Grep, Glob) or command, else one `call` group.
  A call stored with an empty input is
  grouped as `(input not recorded)`, one whose input names nothing
  groupable as `(no detail)`; neither gets a hint. Counts in hint text are
  written with thousands separators.
- **`rows[]`** are the top 12 groups by calls, each `{key, calls}`;
  **`other`** is the calls in every smaller group. Free.
- **Premium** (left out without an active licence, [ADR-022](08-decisions.md)):
  `results`, `failures` and `bytes` for the tool and per row — a result is a
  `tool.post` matched to its `tool.pre` by `key` through the unique
  `(session_id, key)` index, a failure is one whose `is_error` is set, bytes
  are the stored `tool_bytes` (migration 0018); a call with no stored result
  counts as a call and is left out of the rate. Each row's `trend` is 8
  equal buckets of calls placed by `trend_from_ms` and `trend_width_ms`.
  `hints[]` (`{kind, key, text}`, strongest first) are sentences built only
  from those counts: a group failing at least 10% and twice the tool's own
  rate (≥20 results, ≥5 failures), a group returning ≥25% of the tool's
  output when there is more than one, a group holding ≥30% of ≥50 calls.
- **Without a licence** `locked` is true, every Premium field is absent, and
  **`teaser`** carries the strongest hint in full — the one place a Premium
  figure is sent unpaid, on purpose, so the offer shows a real finding
  rather than a blur.

Every figure is counted from stored events; nothing is estimated. No new
index or migration: the pres are read by `idx_events_kind_ts`, the posts by
the unique key. Cached for 60 s; on the owner's 1 GB database (2026-10-04)
Bash for all time — about 54k results — took ≈1.2 s cold.

### Phase 1 additions

**Repository and pull-request links (2026-10-04).** Both are read from the
machine, never from a forge's API (rule 4):

- **`SessionDetail.repo`** — `{root, url, branch?, default_branch?, branch_url?}`,
  absent when the session's directory is not in a repository or the
  repository has no remote a browser can open. `internal/gitremote.Lookup`
  asks the local repository, with a 2 s budget, for its top level and then
  `origin`, else the first remote. `url` is the remote turned into its web
  address: scp-like (`git@host:o/r.git`), `ssh://` (credentials and the ssh
  port dropped), `git://`, `http(s)://` with or without `.git`, GitHub, GitLab
  (subgroups kept), Bitbucket, Azure DevOps ssh, and any other host as
  `https://host/path`. A local path, a `file://` remote, a Windows path or a
  bare alias is not a web address and gives no `url`. `branch_url` links the
  checked-out branch where the host's layout is known — GitHub `/tree/<b>`,
  GitLab `/-/tree/<b>`, Bitbucket `/src/<b>`, Codeberg, Gitea and Forgejo
  `/src/branch/<b>` — and is empty on the default branch (or `main`/`master`
  when the default is unknown) and on an unknown host. A worktree resolves to
  its own top level and branch. The API keeps answers for a minute per
  directory, 500 directories at most.
- **`SessionDetail.prs`** — `[{url, number, title, opened_at, merged_at, closed_at, last_at}]`,
  newest activity first, from `session_prs` (§ Session pull requests DDL).
  Always an array.
- **`projects[].repo_url`, `projects[].last_pr`** on `/v1/stats/summary` — the
  web address of the row's `dir`, and the newest pull request any session in
  that directory recorded (a `SessionPR`). Both are omitted when unknown.
  On macOS `repo_url` is never looked up for a directory macOS guards
  (`protectedDir` → `tcc.Guarded`: Desktop, Documents, Downloads, iCloud
  Drive, `~/Library/CloudStorage`, Music, Movies, Pictures, `/Volumes`, or a
  symlink into any of them, recognised without reading the target): running
  git there makes macOS ask for the folder on opening the dashboard. The
  session's own page still looks it up — the user opened it. Ingest's
  repository lookup and the projects list's automatic additions use the
  narrower `tcc.GuardedBeyondWork`: they read up a session's own folder in
  Desktop, Documents and Downloads (people keep projects there), never in
  Music, Movies, Pictures, iCloud Drive, cloud storage or `/Volumes`, where
  the session is labelled by its folder's name. The full rule shapes
  `GET /v1/browse`: a guarded directory is
  listed with `repo: false` and never read, a symlink into one is listed only
  when its target is inside the browse root, and `GET /v1/recent-dirs` offers a
  guarded recent folder without checking that it still exists.

```
POST   /v1/agents                    {cwd?, chat?, create?, worktree?, worktree_base?, worktree_pull?, worktree_pr?, agent?, subscription?, model?, permission_mode?, subagent_model?, resume?, fork?, command?, args?, attempts?, prompt?, relay_from?, end_when_done?} → {session_id, cwd, session_ids?, attempt_group?, error?}
GET    /v1/attempts/{group}          → {group, base?, attempts: [AttemptView]}; 404 for an unknown group
GET    /v1/agents/models?agent=      {agent, default?, models:[{id,label}]}
GET    /v1/agents/catalog            → {agents: [CatalogEntry], licensed, home?}
GET    /v1/agents/custom             → {agents: [CustomAgent], licensed}
PUT    /v1/agents/custom             {agents: [CustomAgent]} → {agents, licensed}; 402 without an active licence
GET    /v1/subscriptions             → {agents: [{agent, label, installed, subscriptions: [Subscription]}], licensed, free_per_agent, home?}
POST   /v1/subscriptions             {agent: claude|codex, label} → Subscription; 402 at the free number without a licence
PATCH  /v1/subscriptions/{id}        {label?, make_default?, plan?: {kind, label?, usd_per_month?} | null, agent?} → Subscription
DELETE /v1/subscriptions/{id}        → 204; 409 while a session Caprock started runs on it
POST   /v1/agents/{id}/input         {data?, paths?}   → 204   (owned PTYs only); paths are saved files (POST /v1/paste) typed in before data as the terminal types a dropped file: each image its own bracketed paste when the session turned paste on, 150 ms after it; anything else quoted with a space
GET    /v1/agents/{id}/queue         → QueueView; the messages waiting for the turn to end (§ Queued messages)
POST   /v1/agents/{id}/queue         {text} → {sent, queued?, queue: QueueView}; typed in now at the prompt, otherwise queued
POST   /v1/agents/{id}/signal        {action: pause|resume|kill|end} → 204 (owned PTYs only; end = SIGTERM, SIGKILL after 5s)
GET    /v1/agents/{id}/permission    → {permission: {id, tool, detail, always?, since, queued?, agent_id?, agent_type?, waiting?} | null}; the oldest prompt an owned session waits on, queued = how many more are outstanding, waiting = all of them when two or more
POST   /v1/agents/{id}/permission    {id, choice: allow|always|deny|dismiss} → 204; 409 when that prompt is not the oldest outstanding, or no permission menu is on screen at all (the prompt is dropped); 422 {error} when the menu on screen has no such option, or more than one prompt is outstanding (nothing typed); dismiss types nothing and drops that prompt, any of them
WS     /v1/agents/{id}/term          bidirectional stream (xterm.js): binary = keystrokes, text = control; snapshot on connect, closes on exit; subprotocol caprock.term.v2 [?since=&client=] = protocol v2
POST   /v1/paste                     {name, type, data:base64} → {path}; writes a pasted or dropped file so Claude Code can read it
GET    /v1/inbox                     → {items, max}; what was saved for later (§ Inbox)
POST   /v1/inbox                     {text?, project_id?, files?} → {item}; save a note, a link or a photo (§ Inbox)
DELETE /v1/inbox/{id}                → 204; with its files (§ Inbox)
GET    /v1/inbox/{id}/files/{n}      → an item's image, for its thumbnail (§ Inbox)
GET    /v1/brain                     ?q=&project=&since=&until=&limit=&summaries=1 → BrainGraph (§ Second Brain)
GET    /v1/brain/status              → BrainStatus: counts, projects (§ Second Brain)
GET    /v1/brain/handoff             ?project= → {project, memories, max, budget, served?}; what a new session there is handed (§ Second Brain)
GET    /v1/brain/spend               ?days= → BrainSpend; what the automatic reads spent, per day and project (§ Second Brain)
POST   /v1/brain/nodes               {text | title, summary?, kind?, event_id?, session_id?, project?, topics?, pinned?} → {node, created}; no cap
GET    /v1/brain/nodes/{id}          → {node, links}
PATCH  /v1/brain/nodes/{id}          {kind?, title?, summary?, pinned?} → {node}
DELETE /v1/brain/nodes/{id}          → 204; its edges go with it
POST   /v1/brain/links               {from, to, kind?} → 204; DELETE with {from, to} → 204
PUT    /v1/brain/settings            {auto?, daily_tokens?, model?} → BrainAutoStatus; no licence needed
POST   /v1/brain/backfill            {days?, dry_run?} → BrainEstimate; 409 while off (dry run: never)
GET    /v1/terminals                 → {terminals: [{id, name}], preferred}; terminal apps installed here, most preferred first
GET    /v1/editors                   → {editors: [{id, name}], preferred}; editors installed here (F18), this machine only
POST   /v1/editors/open              {path, line?, editor?} → {editor: {id, name}}; this machine only
GET    /v1/browsers                  → {browsers: [{id, name, default}]}; known web browsers installed here and the default, the default first; this machine only
POST   /v1/browsers/open             {browser, url} → {browser: {id, name, default}}; an http(s) url in that browser; this machine only
POST   /v1/sessions/{id}/open-terminal {terminal?, mode?: resume|move|fork} → {terminal: {id, name}, mode, command}
PUT    /v1/sessions/{id}/name        {name} → {session_id, name}; "" clears it; 400 without name, 404 for an unknown session (§ Session name DDL)
PUT    /v1/sessions/{id}/needs       {needs} → {session_id, needs}; "needs me?" / "not needed" on the turn that ended last; 409 mid-turn (§ Needs you and Done)
POST   /v1/sessions/remove           {ids?: [id], cwd_prefix?, dry_run?} → {dry_run, sessions: [RemovalCandidate], skipped: [RemovalCandidate + reason], cost_usd, unmatched_usd}
GET    /v1/overlap                   → {window_minutes, sessions: {id: {checkout, with: [OverlapPeer]}}}; live sessions sharing a checkout (§ Same-checkout overlap)
GET    /v1/history?range=…           lifetime totals + tool distribution + model mix + daily
```

**Same-checkout overlap** (`GET /v1/overlap`, `internal/api/overlap.go`,
`store.Overlaps`). The live sessions (status not `ended`) grouped by
**checkout**: the folder of the nearest `.git` entry above the session's
`cwd` — a clone's root, or a linked worktree's own folder, never folded into
its main repository (`store.CheckoutOf`); a folder in no repository is its own
checkout. Only a session with at least one neighbour is keyed, so the usual
answer is `{"window_minutes": 30, "sessions": {}}`. An `OverlapPeer` is
`{session_id, name, name_source?, started_at, files}`: the neighbour named as
its card names it (`name_source` as `description_source`: `name`, `title` or
`prompt`, a prompt clipped to its first line), and `files`, the absolute paths
both sessions edited in the last 30 minutes (Edit, Write, MultiEdit,
NotebookEdit — `session_files.last_ts` at or after now − 30 min), sorted, `[]`
when they share only the folder. Peers are in start order. Read only: one
query on `session_files` for the sessions in a shared checkout, none when
nobody shares.

```json
{ "window_minutes": 30, "sessions": { "b": { "checkout": "/Users/me/dev/caprock", "with": [ { "session_id": "a", "name": "Login fix", "name_source": "name", "started_at": 1791730800000, "files": ["/Users/me/dev/caprock/ui/main.ts"] } ] } } }
```

**Removing sessions** ([ADR-037](08-decisions.md)). `POST /v1/sessions/remove`
is the machine's alone: every paired device gets `403`, whatever its role, at
the gate and again in the handler. It names sessions by `ids` (at most 500) or
by `cwd_prefix` — the folder itself and everything under it, matched on a path
boundary; a request with neither is a `400`. A `RemovalCandidate` is
`{session_id, cwd, project, agent, status, owned, last_event_at, turns,
cost_usd}`. A session Caprock holds a terminal for, or whose status is
`active`, is listed in `skipped` with a reason and left alone. With `dry_run`
nothing changes. Otherwise, in one transaction per request, each session's
events, `session_stats`, `session_files`, `session_prs`,
`throttle_observations`, `forced_continues`, `pending_permissions` and
`sessions` rows are deleted; its counted turns are taken back out of
`daily_stats` and its `daily_sessions` marks out of the day's session count;
and it is written to `removed_sessions`. `unmatched_usd` is cost whose day row
could not be found to subtract from (zero on the owner's database). The
recorder refuses every later event for a removed session, so a transcript
still on disk never brings it back. The cached aggregates are dropped, so the
next read of any total is without it. `caprock sessions rm [ids…]
[--cwd-prefix dir] [--yes]` calls it; without `--yes` it is a dry run.

**`agent`** is `claude` (default), `codex`, `opencode`, `gemini`, `grok`
(2026-10-10, [23-grok.md](23-grok.md)), `hermes` (2026-10-15,
[24-hermes.md](24-hermes.md): `hermes chat`, `-m`, `--yolo` for
`bypassPermissions`, `-q` for the first message, `chat --resume <native id>`;
`fork` is a 400) or a custom agent, `custom:<id>`
(below); any other value is a 400. `permission_mode` is always in Claude Code's words and each
agent's argv builder translates or drops it (`internal/agents/argv.go`; the
per-agent flags are in [19-codex.md](19-codex.md) and
[16-opencode.md](16-opencode.md)). With `resume`, the agent is the stored
session's, whatever the request says, and a Codex, OpenCode or Hermes resume
is given the session's `native_id` when it has one. `fork` with Codex or OpenCode is a
400: their forks copy history with its cost.

**A request with no `permission_mode` gets one from the daemon**
(`defaultSpawnMode`, `internal/api/resume.go`), so every caller — the
dashboard's buttons, the project terminal, the phone, a script posting to the
API — behaves the same. With `resume` or `relay_from`, it is the mode that session was last
running in: the newest stored hook payload's `permission_mode`
(`store.LastPermissionMode`, the newest 50 hook events, PostToolUse skipped
for size), passed on only when `--permission-mode` accepts it
(`agents.CarriedMode` — Claude Code reports its ordinary mode as `default`,
which the flag does not take, so that one starts with no flag). Otherwise, and
when nothing was recorded, it is the `spawn_permission_mode` setting; with
neither, no mode is sent and the agent starts in its own default. A request
that names a mode, or carries `command`, is left as it is. No column stores the
mode: every hook payload keeps its `permission_mode`, and the mode changes mid-session.

**`bypassPermissions` is spawned as `--dangerously-skip-permissions`**, the
flag the orchestrator has always used for its own unattended workers. Claude
Code maps it to the same mode as `--permission-mode bypassPermissions` (read
in 2.1.292); one spelling keeps the first-run warning and Caprock's consent
for it (ADR-041) on one path. The owner's prompt flood of 2026-10-07 under
bypass was `permissions.blockReadsOutsideWorkingDirectories`, which asks in
every mode, not the flag. The two are never combined. Every other mode is still
`--permission-mode <mode>`.

**`--allow-dangerously-skip-permissions` is added to a Claude Code start in
any other mode, only where the bypass warning was already accepted**
(ADR-054): `skipDangerousModePermissionPrompt` true in the settings the
session reads — the subscription's own `settings.json` when it runs on one
(ADR-048), else the user's. It puts bypass in that session's Shift+Tab cycle
without starting in it. Without the consent the flag is left off, because it
opens the session on the same one-time warning as
`--dangerously-skip-permissions` (read in 2.1.296), and bypass is then
reached by a restart, which asks for the consent first.

**Claude Code sessions are started with `--add-dir` for Caprock's own
directories** (`PasteDir`, `ChatsDir`; `agents.ownDirs`, created if absent
because the flag refuses a directory that does not exist). Caprock writes files
the user then refers to by path — a screenshot pasted into the terminal — and
those paths lie outside every working directory, so a user with Claude Code's
`permissions.blockReadsOutsideWorkingDirectories` on was asked about Caprock's
own files. That setting is a perimeter which applies in **every** mode: neither
`--permission-mode bypassPermissions` nor `--dangerously-skip-permissions`
lifts it, and only a working directory (the flag, `/add-dir`, or
`permissions.additionalDirectories` in *user* settings — a project's
`.claude/settings.json` does not count) satisfies it. Commands whose paths are
computed at run time (`gh`, a `cat` of a variable) cannot be checked against it
and ask regardless; nothing in Claude Code's rules suppresses that, so a user
who wants an unattended run turns the setting off.

The endpoints answer 501 only when
**no** agent can be started (`claude_available`, `codex_available`,
`opencode_available` and `gemini_available` all false on `/v1/status`).

**`attempts` on `POST /v1/agents`** — one prompt, N attempts
([ADR-052](08-decisions.md)). A whole number from 1 to 4; absent or 1 is an
ordinary start. From 2 it needs `worktree` and refuses `resume`,
`relay_from` and `chat` (`400`). The daemon starts the same request once per
attempt, in order, with `worktree` = `<worktree>-1` … `<worktree>-N`;
`worktree_pull` applies to the first only, and the rest get `worktree_base`
= the commit the first copy started from, so every attempt starts from the
same code. Each started session gets an `attempts` row. The first failure
stops the rest: with none started it is `400 {error}`; otherwise `200` with
`session_ids` (in order), `session_id` (the first), `attempt_group`, and
`error` naming the attempt that did not start, and the group's total is what
started. Bypass consent and a controller's limits are checked once, before
any start.

- **`AttemptView`** — `{session_id, group_id, n, total, base?, base_commit?,
  created_at, session: Session, stats: Stats, changes?: {files, additions,
  deletions, binary?}, changes_error?}`. `changes` is what the copy changed
  since `base_commit` (`gitdiff.Since`): committed, uncommitted and untracked
  files git does not ignore, an untracked file's lines read from its first
  1 MiB, at most 2000 of them read; absent with `changes_error` when the
  folder is gone (*its copy has been removed*), is not a repository, or git
  failed. Read concurrently, 10 s each. Open to every paired device.
- **`Session`** carries `attempt_group`, `attempt` and `attempts` (omitted
  when not one of a group), on every list, detail and `session` frame.

**`prompt` and `relay_from` on `POST /v1/agents`** — a relay ([ADR-032](08-decisions.md)).
`prompt` is the new session's first message, passed on the agent's command
line (Claude Code and Codex positional, OpenCode `--prompt`, Gemini CLI
`--prompt-interactive`), so it is sent as the session starts; at most 8000
runes, a leading `-` gets a leading space so no parser reads it as a flag, and
through a Windows `.cmd`/`.bat` shim it is joined onto one line with `%`
doubled, because cmd.exe ends a command at a newline. `relay_from` names the
session being carried on: it is stored as `sessions.relay_from`, and `cwd`
defaults to that session's folder. Refused with 400 and a reason: `prompt`
with `resume` (a continued session has its conversation), `relay_from` with
`resume`, an unknown `relay_from`, a source folder that no longer exists when
no `cwd` is given, and a brief over the limit.

**`end_when_done` on `POST /v1/agents`** — end a one-job session once its
turn finishes (`internal/daemon/enddone.go`, added 2026-10-21). An interactive
TUI does not exit when its work is done — Codex's never does — so a script
that starts a session with a prompt every half hour piled up 27 idle Codex
sessions (94 processes, about 2 GB resident) in a day on the owner's machine.
`end_when_done: true` asks the daemon to end the session the way
`POST /v1/agents/{id}/signal {"action":"end"}` does (asked to stop, killed
after the grace, the plan-window stop released) once its turn finishes and
nothing waits on anyone.

- **Accepted** only for a new Claude Code or Codex session (`agent` absent,
  `claude` or `codex`) with a non-blank `prompt`. Refused with 400 and a
  reason, starting nothing: no prompt, with `resume`, with `command`, for any
  other agent (theirs is a turn end Caprock does not read), and a value that
  is not a boolean. `false` or absent is an ordinary start. With `attempts`
  every attempt carries it. Kept on the manager's own record of the session
  and in its pty-host's metadata (`end_when_done`), so a restarted daemon
  still knows; it is not a database column and is not shown anywhere.
- **The turn finished** is the signal the rest of Caprock reads: Claude
  Code's main-thread `Stop` hook, not turned back into a running turn by the
  task runner's Stop-loop; Codex's `task_complete` in the session's rollout
  (`codex.Ingester.OnTurnDone`; a `turn_aborted` is someone at the keyboard,
  not done). A Claude Code session reattached after a restart is looked at
  once: its stored events ending on the main thread's `Stop` count.
- **Nothing waits** when, 1.5 s after that signal: no permission prompt is
  pending; for Claude Code the newest main-thread hook event is still that
  `Stop` (a question, a prompt or a tool call since means the session moved
  on) and the message queue's own reading is "at the prompt"; no message is
  queued for the session; and no subagent it started still works
  (`store.LiveSubagents`). Otherwise the session is left running and the next
  turn end is looked at the same way. A Codex request that asks for an
  approval has not written `task_complete` yet.
- **Rule 7.** Only a session Caprock started with the flag is ever ended; a
  session started without it, a session Caprock did not start and a shell are
  never touched.
- **Not covered:** Claude Code with Caprock's hooks off (no `Stop` reaches the
  daemon), and a Codex request that finished while the daemon was stopped in
  a rollout not written to since — both stay running until ended by hand, as
  without the flag.

**Ending idle sessions** (`internal/daemon/endidle.go`; owner,
2026-10-21). An agent session Caprock started that no tab shows — a chat from
Chats, Now or the phone, a Telegram `/new` or forward, a continue, relay,
fork or attempt, a row under *Running, no tab* — never ends by itself; on
the owner's Mac 27 idle Codex sessions held about 2 GB. Once one has been
idle for `end_idle_after` (12 h by default), the daemon ends it the way
`POST /v1/agents/{id}/signal {"action":"end"}` does (asked to stop so the
transcript is written, killed after the grace, the plan-window stop
released). The sessions are looked at once a minute.

- **Idle** means, for the whole window, nothing typed into it, nothing drawn
  by it and no event from it, and now: no permission prompt pending, no
  question (`AskUserQuestion`) open, no message queued, no subagent at work
  (`store.LiveSubagents`), and the process not paused (the spend cap, the
  plan-window stop). A turn the hooks still call running is not kept alive
  by that alone: a running turn draws (Claude Code's and Codex's working
  line animates every second), so one with nothing drawn for the window was
  interrupted with Esc, which writes no `Stop`.
- **The last activity** is the newest of the process's start, the session's
  `last_event_at` and the input and output this daemon saw. Output a
  pty-host replays to a daemon that reattaches is not activity (the first
  3 s after the reattach), so a restart does not start the clock again, and
  nothing is ended in the first 3 minutes after a daemon starts, so a
  session that is in fact working has drawn again first.
- **Never ended:** a session Caprock did not start (rule 7: the manager
  holds no other), a shell, a session any dashboard has a tab for (§ Open
  tabs), and the orchestrator and its workers while it runs.
- **Marked, not hidden.** Before the end is asked for, the row gets
  `idle_ended_at` (unix ms) and `idle_ended_after` (the window, ms;
  migration 0067), in the `Session` JSON as `idle_ended_at` and
  `idle_ended_after_ms`, omitted when 0. Both go back to 0 when the session
  is started again (`store.MarkOwned`): continued with `--resume` under its
  own id, it is an ordinary session. A Telegram reply to a session ended
  this way continues it with the reply as its next message (`resume` plus
  `prompt`, in the mode it last ran in); a reply to one ended otherwise is
  still refused.

**Open tabs** — `PUT /v1/tabs` `{"viewer": "<id>", "sessions": ["<id>",
…]}` → `204`. Tabs live in the browser, so the dashboard tells the daemon
which sessions it has a tab for: the whole list in tab-strip order (each
pane of a split in turn), at once when it or its order changes and every 10
minutes while it is open (`ui/src/lib/reportTabs.ts`). Only the app
workspace (`screens/AppShell.tsx`) reports; the phone's page never does.
`viewer` is a random id the browser keeps (`caprock.app.viewer-id`), 1–64
characters; `sessions` at most 500, blank and repeated ids dropped (the
first kept); otherwise `400`. Each viewer's last list is kept in
`<data_dir>/open-tabs.json` (`{"viewers": {"<id>": {"at": <unix ms>,
"changed": <unix ms>, "sessions": [...]}}}`; `changed` is when the list or
its order last changed, absent in a file from before it, which then reads as
`at`; written when the list changes or is an hour old), so a restarted daemon
still knows, and so does one whose app was closed for the night. A viewer
that has not reported for 7 days no longer counts. `501` when the daemon
keeps no list.

`GET /v1/tabs` → `TabsAnswer` `{"known": bool, "at": <unix ms>, "sessions":
[...], "items": [SessionSummary...]}`: the list the phone home's Continue
mirrors (04-ui.md § The phone home). Of the viewers within the 7 days, one
that reported in the last 30 minutes (on screen: three heartbeats) wins over
one that did not, then the one whose list changed last — so two windows
heartbeating the same lists never take turns — then the later report, then
the lower viewer id. `sessions` is that list as reported, file and page keys
included; `items` is each of them that is a session in the store, in the
same order, as `GET /v1/sessions` describes it, shells left out. `known` is
false (and the arrays empty, `at` 0) when no viewer counts. A paired device,
viewer or controller, may read it (`pairedDeviceRoutes`); it may not report
(`PUT` stays the machine's). `501` when the daemon keeps no list.

**`GET /v1/sessions/{id}/prs`** → `SessionPRs` `{connected, prs, fetched_at,
refreshing?}`: the session's latest
four pull requests (`session_prs`, newest first; the current one and up to
three before it, `sessionPRsShown`; three until 2026-10-12), each a `SessionPR` plus
`live` — the `github.PR` GitHub returns for its link now (state, checks,
review) — or `error` when GitHub was asked and failed. While GitHub is not
connected nothing is sent and `live` is absent. Each pull request is kept
per link for 20 s while its checks run, 2 min once they settled and 30 min
once merged or closed (`github.PullByURL`), so the deck polling it costs
GitHub nothing in between; every read is conditional. The row's state chips
read fields this answer already carries (`mergeable`, `mergeable_state`,
`review`, `draft`, and `auto_merge` for its *queued*); nothing is asked per
chip.

**The deck's answers are kept** (`internal/api/deckcache.go`). The five
views of the *Pull requests & CI* cell — `…/prs`, `…/ci`, `…/ci/release`,
`…/ci/main`, `…/branches` — and the Pipeline's `…/ci/stats` are each composed from the kept GitHub reads
above, and the composed answer is kept per view, session, pull request
asked for and whether GitHub is connected (at most 256 keys). A key never
composed is composed while the request waits, and concurrent requests for
it share one composition — except `…/prs`: when its first composition takes
longer than 300 ms (it has to ask GitHub), the request gets the session's
pull requests as recorded (`SessionPR` fields, no `live`, no `error`) with
`refreshing: true` at once, and the composition goes on to be kept for the
next poll (`serveDeckOrQuick`, 2026-10-13). Within 2 s the kept answer is handed back as it
is. Past that, the request starts one background composition (on a
context of its own, 15 s) and waits up to 300 ms for it: when the GitHub
reads answer from what they keep it lands inside that and is handed back;
when one has to ask GitHub, the request gets the last answer at once with
`refreshing: true`, and the next poll finds the new one. A kept answer
older than an hour is not shown; the request waits for a fresh one. A
composition that fails (a database error, an unknown session, its deadline)
is not kept and the last answer stays — said so: the answer handed back
carries `refresh_error` (the failure in words; a deadline is "GitHub or the
database did not answer in time") and `refresh_failed_at` (Unix ms), is not
marked `refreshing`, and no new composition starts for 20 s
(`deckFailBackoff`, 2026-10-14; before, one that failed every time restarted
on every poll behind `refreshing: true`). Every answer carries `fetched_at`, Unix ms, when
the daemon composed it, and `refreshing`, `refresh_error` and `refresh_failed_at` only when set. GitHub is asked no
more often than before: a composition calls the same kept reads a request
used to, each deciding by its own freshness whether to ask.

**`POST /v1/sessions/{id}/prs/{number}/rerun`** (no body) → `{ok, mode,
runs, jobs}`: the session deck's *Re-run checks*. Acts only on a pull
request in the session's `session_prs`, or one of its repository's that
the Pipeline listed — in the last `…/ci/stats` list read
(`github.CachedRepoPull`), so no number a request merely names is acted on
— 404 otherwise; read through
`github.PullByURL` for its head commit. `github.RerunChecks` reads that
commit's runs afresh, then asks GitHub `POST
/repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs` for every finished run
that failed (`mode: "failed"`), else `POST …/runs/{id}/rerun` for every
finished run (`mode: "all"`: a flaky green the user wants checked again);
a run still going is left alone, and with none finished the answer is 409
`kind: "state"`. `runs` is how many runs were asked, `jobs` how many jobs
that re-runs. The commit's kept runs and the repository's kept pull
requests are dropped so the next poll shows them queued. A refusal is the
usual GitHub error body (`githubFail`): 403 is `kind: "scope"` with `needs`
from GitHub's `X-Accepted-GitHub-Permissions`, else the documented
`"Actions" repository permission (write)` / `"repo"` scope; it does not mark
the connection's health line.

**`POST /v1/sessions/{id}/prs/{number}/update-branch`** (no body) → `{ok}`:
the deck's *Update branch*. The same pull request check, then 409 `kind:
"state"` when it is not open or GitHub says it conflicts (`mergeable`
false); else `github.UpdateBranch` sends `PUT
/repos/{o}/{r}/pulls/{n}/update-branch` with `expected_head_sha` = the head
last read, so a push made since is refused rather than merged over (said as
*The branch moved since Caprock last read it*). A 403 names `"Pull requests"
repository permission (write)` when GitHub names nothing. Both routes are
writes to the user's own repository with the user's own token, sent on a
click and a confirm, never by a poll (rule 4), and are the machine's: not in
the paired-device lists.

**`GET /v1/sessions/{id}/ci`** (`?pr=N` optional) → `SessionCI` `{connected,
pr?, ci?, error?, fetched_at, refreshing?}`: the session deck's CI cell. `pr` `{number, url, title?,
state?, repo, head_sha?, live?}` is pull request N when it is among the session's
latest four (a click on its row or its mini pipeline) or one of its
repository's that the Pipeline listed (as the rerun route checks), else the
session's open one among them, else the newest (each read through `github.PullByURL`, so it shares the PRs
cell's reads; `live` is that `github.PR`, for the tab's review, merge state
and diff size). `ci` is `github.CI` for that PR's head commit: `{repo,
head_sha, state, runs[], runner_ms, by_os[], cost?, at, error?}`, `state` one of
`running | fail | pass | none`. Each run `{id, name, event?, status,
conclusion?, attempt?, html_url?, created_at?, updated_at?, started_at?,
head_branch?, head_sha?, workflow_id?, jobs[], cost?}` (`started_at` is GitHub's
`run_started_at`; `head_branch` is the tag for a tag push or a release); each
job `{id, run_id, name, status, conclusion?, started_at?, completed_at?,
duration_ms?, labels[], os?, runner_name?, runner_group_name?, html_url?,
steps[], cost?}`; each step

head_branch?, head_sha?, workflow_id?, jobs[], baseline?}` (`started_at` is GitHub's
`run_started_at`; `head_branch` is the tag for a tag push or a release); each
job `{id, run_id, name, status, conclusion?, started_at?, completed_at?,
duration_ms?, labels[], os?, runner_name?, html_url?, steps[], baseline?}`; each step
`{number, name, status, conclusion?, started_at?, completed_at?,
duration_ms?}` — times unix ms, durations `completed_at - started_at` from
GitHub's own stamps and absent until both are known. `os` is read from the
runner labels: `linux | windows | macos | self-hosted`, absent when they
name none. `runner_ms` sums the finished jobs and `by_os` `[{os, ms}]`
splits it, largest first, as raw time with no rate applied (a
running job's time is the reader's clock minus `started_at`). The dollars
are in `cost` (see **Runner cost** below). Read from
`GET /repos/{o}/{r}/actions/runs?head_sha=…&per_page=10` and
`GET …/actions/runs/{id}/jobs?per_page=100` (the latest attempt), kept per
commit for 10 s while any run or job is unfinished and 2 min once all
settled (`github.CIBySHA`); a settled run whose `updated_at` and attempt
are unchanged keeps the jobs read before. While GitHub is not connected
nothing is sent: `connected` is false, `pr` is the newest recorded one and
`ci` is absent. A failed read keeps the last answer with `ci.error` set.

**CI baselines.** On the three CI routes (`/ci`, `/ci/release`'s `run`,
`/ci/main`) each run and each job may carry `baseline` `{median_ms, runs}`:
for a run, the median of `updated_at - run_started_at` over the newest
successful runs of the same workflow on the repository, other than the runs
shown, up to 5; for a job, the median `duration_ms` of the jobs of the same
name that succeeded in those runs. Absent with fewer than 2 samples — never a
guessed figure (rule 6). Read by `github.WithBaselines` from
`GET …/actions/workflows/{workflow_id}/runs?status=success&per_page=8`, kept
per workflow 30 min, and `GET …/actions/runs/{id}/jobs?per_page=100` per past
run, kept for the daemon's lifetime (a finished run's jobs do not change; up
to 256 runs and 64 workflows, the oldest read dropped first). Only these
routes ask for it, so nothing is read while the deck is closed; nothing is
sent while GitHub is not connected; a failed read is no baseline, not an
error. The cached answers are never changed: the baselines are set on a copy.

**`GET /v1/sessions/{id}/ci/stats`** → `SessionCIStats` `{connected, repo?,
reason?, prs[], stats?, board?, error?, read_at?, fetched_at, refreshing?,
refresh_error?, refresh_failed_at?}`: the Pipeline
(.ai/21-app.md § Pipeline), asked only while that page is in front, or
Home's CI/CD section is unfolded and in front (its Pipeline figures), or
the phone home's Releases is opened, refreshed or told of release news
(04-ui.md § The phone home), and the window visible. A paired device may
read it (`pairedDeviceRoutes`); nothing on it writes. `repo` and `reason` as `SessionRepoCI` says them. `prs`
is the repository's own pull requests — the `BranchPR` list the Branches
view reads (`GET …/pulls?state=all&sort=updated&direction=desc&per_page=50`,
kept 2 min; `github.RepoPulls` shares the read with `PullsByBranch`), most
recently updated first, a fork's left out. `stats` is `github.RepoStats`
over the 14 local calendar days ending today:

- **Merges** — `days[]` (`2006-01-02`, oldest first), `merged[]` (pull
  requests merged each day), `ttm_median_ms?` and `ttm_count` (the median
  of `merged_at - created_at` over the pull requests merged in the window,
  absent with fewer than two), `prs_listed` (how many the counts read).
- **Runs** — `ci` `{runs, red, reruns, listed, oldest?, per_day[{runs,
  red}], workflows[]}` from `GET …/actions/runs?per_page=100` (every
  workflow and event, without jobs), kept 30 min, 2 min while one of them
  is unfinished (`github.RepoRuns`).
  `runs` counts the finished runs that passed or failed, `red` the failed
  ones (`failure`, `timed_out`, `startup_failure`); cancelled, skipped and
  unfinished runs are neither. `reruns` counts runs on an attempt past the
  first; `listed` and `oldest` (unix ms) say how far back the 100 runs
  reach. Each workflow `{name, runs, red, median_ms?, median_runs,
  daily_median_ms[]}`: the median of `updated_at - run_started_at` over its
  successful runs (absent with fewer than two; a day's 0 likewise), the
  workflow with the most such time first.

- **Board** (2026-10-14) — `board` `{cards[], releases[], flow,
  default_branch?, ships_by?}`, the tab's Board view (`internal/api/prboard.go`). Each
  `BoardCard` `{number, stage, stage_at?, ci?, why?, failed[]?, os[]?, ci_ms?, review?, release?,
  spend, stale?}` is a pull request of `prs` (its title, `author`, `author_avatar`
  and link are that entry's); closed unmerged ones and merges before the 14
  days are left out. `stage` is `draft`, `open` (checks running, or not
  read), `fix` (`why`: `ci` a failed check, `conflict` GitHub's `mergeable`
  false or `mergeable_state` `dirty`, `changes_requested`; with `ci`,
  `failed` names up to 3 failed checks, or failed workflows when read from
  the runs list), `os` its live-read checks by the OS their names say (*go
  (windows-latest)*, *test (ubuntu-24.04)*; skipped ones left out), each
  `{os, state, since?, checks}` — `os` `linux`, `macos` or `windows` in that
  order, `state` `fail` when any failed, else `running` while any is
  unfinished (`since` its unfinished checks' earliest start), else `pass`;
  absent with no live read or when no check names an OS (2026-10-16, the
  release plan's dots), `ci_ms` the span of its live-read (else
  runs-list) checks from the first start to the last finish once they
  passed or failed, absent while running or without the stamps (2026-10-16,
  the release plan's CI time), `ready` (checks
  passed, or none ran), `merged` or `released`. An open pull request's
  checks are the deck's kept read (`github.PullByURL`) for the newest 12
  open ones, read 4 at once (`boardLiveParallel`), else the runs list by
  head commit (`ci` absent when it has none of them). One whose read did not
  finish within the composition's GitHub budget, or that GitHub refused,
  keeps its last read and is marked `stale: true`; one that read merged or
  closed while the list still said open leaves the open stages at once; `stage_at` is when its checks started (open) or ended (fix,
  ready), else when it was opened. A merge into the default branch is
  `released` in the first release published after it — matched by time, an
  estimate — and `stage_at` is that release's publish time, else `merged`
  at `merged_at`. Waiting stages are ordered longest-waiting first, merges
  newest first. `spend` is `store.PRSpend` (§ Pull request spend). Each
  `BoardRelease` is a `RepoRelease` plus `prs[]` (the listed merges it
  shipped), `cost_usd`, `sessions` and `partial` (the list may not reach
  back to the release before it), newest first, at most 6. `flow`
  `{counts{stage}, days, merged, ttm_median_ms?, ttm_count,
  release_lag_median_ms?, release_lag_count, release_gap_median_ms?,
  release_gap_count, ci_median_ms?, cost_usd, series}`:
  merged → released is the median of publish minus merge over the window's
  released cards (absent with fewer than two), CI the busiest workflow's
  median. `release_gap_median_ms` is the median time between consecutive
  published releases among those already read (the newest ten; no further
  GitHub read), absent with fewer than three gaps; `release_gap_count` is
  how many gaps there were (2026-10-15, ADR-064). It is how often the
  repository ships, never a date for the next release. The releases are `GET …/releases?per_page=10`
  (`github.RepoReleases`): `{tag, name?, url?, published_at, prerelease?,
  assets}`, `assets` the count of its files GitHub says are `uploaded`
  (one still being sent is not counted; 2026-10-16, the release plan's
  builds count), drafts and unpublished ones left out, kept 2 minutes (10 before
  2026-10-14: a new release missed the board that long); a failed list
  keeps the last one, and with none is no releases, not an error.
  `ships_by` (2026-10-18; owner, translated: "why isn't merged the final
  state — there's one more step after it") is how merged work ships in
  the repository: `release` when one of those releases was published, or
  one of the checkout's newest tags (`relplan.Tags`, local, as of the
  last fetch) naming a version (`v0.132.0`, `1.4`, `app-v2.0.1`) was made,
  within the last 180 days (`shipsRecentDays`); `merge` when neither was
  and both the release list and the tags were read — a site deployed on
  every merge, where merged is the last step; absent when either read
  failed (or an older daemon), and the dashboard then draws the released
  step as not known.
- **The figures day by day** (2026-10-15) — `flow.series` is
  `{flight?, throughput?, ci?, ttm?, lag?, cost?}`, each `[{day, value?, n,
  by_now?}]`: one point per local calendar day of the window (the daemon's
  time zone, cut at local midnight), oldest first, today last
  (`internal/api/prboardseries.go`). Counted from what the board already
  read — the list's stamps, the runs list, the releases — with no further
  GitHub request. `n` is how many samples the value rests on; `value` is
  absent on a day with none for a median (a gap, never a zero).
  `flight` is the pull requests open at each day's end (opened by then,
  not yet merged or closed; a closed one without `closed_at` is left out),
  today's point the In flight figure itself. `throughput` is the merges
  each day; `cost` the agent cost (`spend.cost_usd`) of the pull requests
  merged that day; both carry `by_now`, the same up to the clock time it is
  now. `ci` is the busiest workflow's successful runs' median by the day
  they started (absent with no workflow), `ttm` opened → merged by merge
  day, `lag` merged → released by the day the release was published (so a
  merge not yet released is in no day); a day's median of one sample is
  that sample. Needs a fix and Ready have no series: a past day's check
  state is not in anything read. Each `BranchPR` also carries
  `closed_at?` (GitHub's stamp, unix ms, merged or not) from the same list.
- **Who opened it** — each `BranchPR` (here and in the Branches view) also
  carries `head` (the head branch), `author` and `author_avatar` (GitHub's
  `user.login` and `user.avatar_url`, an address on
  `avatars.githubusercontent.com`) from the same list, and `labels?`
  `[{name, color?}]` (2026-10-14; GitHub's label names and hex colours, at
  most 6, absent with none) for the Pipeline's label chips.

Nothing is sent while GitHub is not connected: `connected` is false, `prs`
empty, `stats` and `board` absent. A failed list keeps the last one, with
`error` set to GitHub's refusal; a failed run list leaves `stats` counted
from the pull requests alone with `error` set. `read_at` (Unix ms) is when
GitHub last answered what the board draws on, the older of the pull request
list's and the releases' reads (`github.RepoPullsRead`,
`RepoReleasesRead`); with `error` it is the time of the data shown. What
did not fit the GitHub budget is said in `error` too (kind `network`, "GitHub
did not answer in time for …"): releases never read, or open pull requests
whose checks are an earlier read. The
GitHub reads of one composition share a 10 s budget (`statsGitHubBudget`)
and the database reads after them run outside it, the composition within
20 s: a slow GitHub gives an answer with stale cards, never a failed one
(2026-10-14: a dozen open pull requests read one after another overran the
15 s deadline on every refresh, and the board stayed on its afternoon
answer for hours). The answer is kept with the deck's (key `stats`).

**`GET /v1/sessions/{id}/ci/release`** and **`GET /v1/sessions/{id}/ci/main`**
→ `SessionRepoCI` `{connected, repo?, reason?, branch?, release?, ci?,
error?, fetched_at, refreshing?}`: the CI cell's Release and Main views, for any repository. `repo`
(`owner/name`) is read from the session's working directory's remote, as the
session page reads it (`gitremote.Lookup`, kept a minute); `reason` is
`no_repo` (not a git repository, or no remote) or `not_github` when there is
none to read, and nothing is sent. The default branch is git's own
(`refs/remotes/<remote>/HEAD`), else `GET /repos/{o}/{r}`'s
`default_branch`, kept an hour. While GitHub is not connected nothing is
sent: `connected` is false and `repo` says which repository a click would
read.

- **Release** — `release` is `github.ReleaseCI` `{repo, tag?, state, run?,
  estimate?, release?, at, error?}`. The release run is found without
  knowing the workflow's file: the newest run, by `created_at`, among
  `GET …/actions/runs?event=push&per_page=30` and
  `GET …/actions/runs?event=release&per_page=5` whose event is `release`, or
  is `push` with a `head_branch` that reads as a tag (`v1.2.3`, `1.2`,
  `v1.2.3-rc.1`, `app/v1.2.0`, `release-1.4`; never the default branch;
  `github.IsReleaseRun`). `tag` is its `head_branch`; `run` is a `CIRun`
  with its jobs and steps; `state` is `running | fail | pass | none`
  (`none`: no release run among those). While it runs, `estimate`
  `{median_ms, runs}` is the median of `updated_at - run_started_at` over
  the newest successful release runs of the same workflow
  (`GET …/actions/workflows/{workflow_id}/runs?status=success&per_page=30`),
  up to 10, the running one left out, absent with fewer than 2 — GitHub's
  own stamps, kept per workflow 30 min, and an estimate that the UI labels
  so. Once it passed, `release` `{url, published_at?, draft?}` is
  `GET …/releases/tags/{tag}` (a 404 is "no release", not an error, and
  does not mark the health line), kept 30 min once found, 2 min until then.
- **Main** — `branch` is the default branch and `ci` is a `github.CI` with
  `branch` set: the newest run of each workflow among
  `GET …/actions/runs?branch={branch}&per_page=30` (up to 8 workflows,
  newest first), with jobs and steps; `head_sha` is the newest run's.

Both are kept per repository (and branch) as a commit's CI is: 10 s while a
run is unfinished, 2 min once settled; a settled run whose `updated_at` and
attempt are unchanged keeps the jobs read before; a failed read keeps the
last answer with its `error` set. An unknown session is 404.

**Runner cost** — every `CIJob`, `CIRun` and `CI` above (the PR, Release and
Main views alike) carries what its GitHub-hosted minutes cost at list rate,
from the runner rate table `pricing/actions.json` (§ Pricing table;
`internal/github/runnercost.go`). An estimate, labelled so: it is before a
private repository's included minutes, which a job cannot know are left.

- **Job `cost`** — `RunnerCost` `{priced, reason?, sku?, display?, match?,
  larger?, rate_usd_per_min?, minutes_billed, usd, free_public}`.
  `minutes_billed` is `duration_ms` rounded up to the whole minute, each job
  on its own, as GitHub bills it; `usd` is `minutes_billed ×
  rate_usd_per_min`. `free_public` is a standard runner in a public
  repository: `usd` is 0 and `minutes_billed` still says what it took. A
  larger runner is charged in a public repository too.
- **Unpriced, never guessed** — `priced` false with `reason`: `self_hosted`
  (any label `self-hosted`, whatever else the labels say), `unknown_runner`
  (no label the table documents and no name that spells a SKU it has),
  `unfinished` (queued or running; nothing counted yet) or `no_table`.
- **Finding the SKU** — `match` `label`: a workflow label GitHub documents
  for standard runners and macOS larger runners, case-insensitive
  (`ubuntu-latest`, `ubuntu-24.04` → `actions_linux`; `ubuntu-24.04-arm` →
  `actions_linux_arm`; `windows-latest` → `actions_windows`;
  `windows-11-arm` → `actions_windows_arm`; `macos-latest`, `macos-14`,
  `macos-15-intel` → `actions_macos`; `macos-*-large` → `macos_l`;
  `macos-*-xlarge` → `macos_xl`; the full list is the table's `labels`).
  `match` `name`: a Linux or Windows larger runner's chosen name, from a
  label or `runner_name`, that states the OS and the core count
  (`ubuntu-latest-4-cores` → `linux_4_core`, `linux-8-core-arm` →
  `linux_8_core_arm`, `windows-16-cores` → `windows_16_core`), used only when
  that SKU exists in the table and is a larger runner. GPU runners have rows
  but no label, so a GPU job is `unknown_runner`.
- **Run and commit `cost`** — `CICost` `{usd, minutes_billed, free_minutes,
  unpriced_minutes, priced_jobs, unpriced_jobs, unfinished_jobs, partial,
  visibility, table_version?, table_source?}` sums the finished jobs
  (`table_source` is the table's `source` page, for the deck's tooltip): `minutes_billed` and
  `usd` the charged ones, `free_minutes` the public standard ones,
  `unpriced_minutes` the finished jobs with no price. `partial` is true when
  a job is unfinished or unpriced (with minutes), so the sum is short of the
  whole. `CI.cost` is the commit's — for the PR view, the pull request's
  head commit's runs.
- **Visibility** — `public | private | unknown`, the `private` field of
  `GET /repos/{o}/{r}`, the same read the default branch comes from and kept
  with it for an hour (`github.RepoVisibility`). An unreadable repository is
  `unknown`, priced at the list rate, and not asked again for 10 minutes.

**Session branches** — **`GET /v1/sessions/{id}/branches`** →
`SessionBranches` `{connected, repo?, reason?, default?, base?, current?,
branches[], error?, fetched_at, refreshing?}`: the session deck's Branches view. Read only while that
view is shown.

- **Git** — local only (`internal/branches`): one `for-each-ref` over
  `refs/heads` and `refs/remotes/origin` in the session's directory, with
  `%(ahead-behind:<base>)` (2.41 and later; on an older one a `rev-list
  --left-right --count` per branch, the 40 most recently committed), kept
  10 s per directory. `default` is the default branch (the remote answer
  the session page already keeps, else `origin/HEAD`, else `main` or
  `master`); `base` the ref counted against (`origin/<default>`, else the
  local one); `current` the checkout's branch. A folder that is no
  repository is `reason` `no_repo` with no rows.
- **Each branch** — `{name, current?, default?, local, remote, ahead?,
  behind?, committed_ms, author?, sha?, subject?, pr?, live?, cost_usd, sessions,
  agents[], session_at?, activity_at, stale?, landed?, in_pr?}`. A local branch and origin's
  copy are one row (the local one's commit); other remotes and origin's
  `HEAD` are left out. `ahead` and `behind` are absent when not counted.
- **Its PR** — `pr` `{number, url, title?, state, draft?, base?,
  head_sha?, created_at?, merged_at?}` (unix ms, GitHub's stamps) from one `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc&per_page=50`
  per repository, kept 2 min (`github.PullsByBranch`): the branch's open
  PR, else its most recently updated; a fork's same-named branch is not
  this repository's; the default branch has none. `live` is an open PR read
  through `github.PullByURL` (its checks, for the mini pipeline), the
  newest eight open ones: the same kept reads the PRs view makes. Nothing
  is sent while GitHub is not connected; a failed list keeps the last one,
  else `error`.
- **Spend** — `cost_usd`, `sessions`, `agents` and `session_at` sum the
  sessions whose `repo_root` is the session's and whose `git_branch` is the
  branch (`store.SpendByBranch`: `session_stats.cost_usd` at API list
  price; the branch a session was on when Caprock saw it), read through
  `idx_sessions_repo_branch` (§ Branch spend DDL).
- **Order and stale** — the current branch first, then `activity_at` (the
  later of the last commit and the newest session event), newest first.
  `stale`: no commit in 30 days and no open PR; never the default branch.
- **Subject and landed** (2026-10-18, the release plan's pushed branches) —
  `subject` is the last commit's subject line (`%(contents:subject)`, read
  after a NUL so a tab in it is kept). `landed` is true when the branch's
  changes are already on `base` (`branches.Landed`), by any of, cheapest
  first: every commit `base` lacks has a patch-equivalent there (`git
  cherry`); merging it changes nothing (`git merge-tree --write-tree <base>
  <sha>`, git 2.38+, gives `base`'s own tree); every non-merge commit's
  subject (16 characters or more) is named in a message on `base` since the
  merge-base — the line itself, a squashed batch's `* subject`, or with
  ` (#N)`; or file by file the branch's own diff (merge-base..sha) is in
  that file, on `base`'s tip or in one of `base`'s last 20 commits since the
  merge-base that touched it: each hunk's new side (context and added
  lines, in order) stands in the file, an added file was there, a deleted
  one gone (one `git diff`, one `git log`, one `git cat-file --batch`; a
  branch of more than 80 changed files is not checked this way). So a
  branch shipped by a squash or inside a batch is found after `base` edited
  the same files or a release consumed its changelog fragment (owner,
  2026-10-19: six shipped branches were listed). `in_pr` is the number of
  the open PR whose branch already carries the branch's last commit (a
  batch PR; `git rev-list <base>..<pr head>`, at most 500 commits each, the
  newest eight open PRs); such a branch is not checked for `landed`. Both
  are checked only for a branch ahead of `base`, committed in the last 14
  days, with no open PR of its own, `landed` for the newest 40, each pair
  of commits once (kept in memory); a failed check (an older git, an
  unknown commit) leaves it absent, never true.

**`GET /v1/github/actions-usage`** (`?owner=` optional) → `ActionsUsage`
`{account, org, year, month, available, reason?, needs?, minutes, gross_usd,
discount_usd, net_usd, by_sku[], endpoint?, at, error?}`: what GitHub itself
billed for Actions this month (UTC), read from its billing usage report only
when this route is asked — never polled — and kept 30 minutes per token,
account and month.

- **Which report** — the connected account's
  `GET /users/{username}/settings/billing/usage?year=&month=` when `owner` is
  absent or the account's login; otherwise the organization's
  `GET /organizations/{org}/settings/billing/usage?year=&month=` (`org`
  true). Both are documented as available only on GitHub's enhanced billing
  platform.
- **Sums** — rows whose `product` is `actions` (any case); `minutes` sums
  the rows whose `unitType` is in minutes, the dollars sum every Actions row
  (storage included); `by_sku[]` `{sku, unit_type, quantity, gross_usd,
  discount_usd, net_usd}` per SKU and unit, largest gross first. Net is
  after GitHub's discount, which is how included minutes appear.
- **Not available is an answer, not an error** — 200 with `available` false
  and `reason`: `not_connected` (nothing sent), `permission` (403; `needs`
  is what GitHub's `X-Accepted-GitHub-Permissions` or
  `X-Accepted-OAuth-Scopes` names, else the documented permission: the
  "Plan" user permission (read) for a fine-grained token, or for an
  organization the "Administration" organization permission (read) and
  being its administrator — docs.github.com/en/rest/billing/usage, read
  2026-10-12), `not_found` (404: no such account, or not on enhanced
  billing) or `error` (anything else, with `error`; not kept, so the next
  ask tries again). A refusal does not mark the GitHub health line. A
  malformed `owner` is the usual `invalid` failure.
- **Who** — the machine only: a paired phone gets 403, as billing is the
  account's spending.

**`GET /v1/sessions/{id}/ci/jobs/{job}/log`** → `CILog` `{job_id, lines[],
error_line, truncated?}`: the end of one finished job's log, for a job the
CI cell lists for this session in the view `?view=` names — `pr` (the
default, with `?pr=N` as above), `release` or `main` — only (else 404; 409 while GitHub is not
connected).
`GET /repos/{o}/{r}/actions/jobs/{job}/logs` is asked on the API host with
the token and its redirect is not followed by that request; the signed
address it names is fetched without the token, only over https and only on
`*.actions.githubusercontent.com` or `*.blob.core.windows.net`, where
GitHub keeps logs (any other host is refused). At most 32 MiB is read; of
its last 400 lines, `lines` is up to 50 before the last `##[error]` line
and 10 after it (`error_line` its index), or the last 60 with
`error_line: -1` when none is marked — the runner's timestamps cut, each
line at most 400 bytes, the whole at most 24 KiB. Kept per job for 30 min:
a finished log does not change. GitHub failures answer as the other GitHub
routes do (`{error, kind, …}`); an expired log is `not_found`.

**`GET /v1/sessions/{id}/relay`** → `RelayBrief` `{session_id, agent, cwd,
cwd_exists, passage_at?, git?: {branch?, base?, files[], more?, stat?,
not_repo?}, prs: [{number, url}], text}` — what the "Continue in…" dialog
proposes, built locally (`internal/relay`): the newest main-thread passage of
at least 400 runes (else the newest), clipped to 2400; the working tree from
`gitdiff.Diff`, up to 25 files as `<status> <path> (+a -d)`; and the PRs the
session opened, from Claude Code's `tool_response.gitOperation.pr` with
`action = "created"` (other agents record none, so none are listed). Nothing
is sent anywhere by this call. Not open to paired devices.

**`GET /v1/agents/models?agent=`** — the models an agent's own CLI lists. For
`codex`: the `visibility: "list"` entries of `$CODEX_HOME/models_cache.json` in
`priority` order, and `default` from the top-level `model` in `config.toml`.
`claude`, `gemini`, `opencode`, `grok` and `hermes` answer an empty list; an unknown
agent is a 400. No network I/O. Kept for older pages; the pickers read the
catalog below.

**`GET /v1/agents/catalog`** — every agent the pickers offer, installed or not
([ADR-046](08-decisions.md)), in their order: Claude Code, Codex, OpenCode,
Gemini CLI, Grok, Hermes, then the custom agents. Hermes is `observed: true`
and `typed_model: true`; when its `config.yaml` (under `$HERMES_HOME`, else
`~/.hermes`) names no `model.default`, its `setup` is `no_provider` with the
command `hermes model` — only whether the key is set is read, never its
value ([ADR-069](08-decisions.md)). A `CatalogEntry` is `{id, label,
installed, ready, default?, models: [{id, label}], typed_model?, observed,
custom?, locked?, prompt, setup?: {reason, text, command?, docs?}}`:
`installed` is the binary found (the rule under `/v1/status` below); `ready`
is installed with nothing Caprock can see missing; `models` are what the
agent's own files list — Codex's `models_cache.json` (as above), the models
of the providers connected to OpenCode (`provider/model` ids, at most 300,
from `<cache>/opencode/models.json`; a provider is connected by a credential
in `<data>/opencode/auth.json`, an entry in its config's `provider`, or one of
its catalog `env` variables set in the login shell; `default` is the config's
`model`; JSONC accepted), Grok's `models_cache.json` (hidden ones left out), a
custom agent's own list — and empty for Claude Code and Gemini CLI, whose
checked lists the page keeps. `observed` is false for Grok and custom agents
(Caprock does not read their sessions). `prompt` is false for a custom agent
whose arguments have no `{prompt}`. `setup.reason` is `not_installed` (with
the official install command and docs page), `no_provider` (OpenCode, `opencode
auth login`) or `signin` (Grok without `auth.json` or `XAI_API_KEY`, `grok
login`; a hint — the session still starts). `locked` marks a custom agent the
licence no longer covers. `licensed` is the licence state; `home` the folder a
setup shell opens in. Reads files and the login environment only: nothing is
run and nothing goes over the network. Open to a controller phone (read-only,
like the model list).

**Custom agents** (Premium, ADR-046). A `CustomAgent` is `{id, name,
command, args?, models?}`, stored as `custom_agents` in `config.json`.
`PUT /v1/agents/custom` replaces the list: `402` without an active licence,
`403` from any paired device, `400` with the reason when a name or command is
missing, the command holds a space but no path separator (arguments belong in
`args`), a field holds a line break or control character or is over 512
bytes, two ids collide, or there are more than 20 agents, 32 arguments or 50
models. `id` is made from the name when absent (`aider-local`), lowercase
letters, digits and dashes, at most 32; one that names a built-in agent gets
`-custom`. `args` is a template: `{prompt}` is the first message and
`{model}` the model; an argument whose placeholder has no value is left out,
and so is the flag right before it when the argument was the placeholder
alone. A spawn with `agent: "custom:<id>"` is refused without an active
licence, for an id not in the config, for a command not found (resolved like
an agent's binary), and from any paired device; otherwise the daemon starts
the configured command with the filled arguments — the request never carries
the command — and drops `model`, `permission_mode` and `fork`, which it cannot
map. A custom session is recorded with `agent = "custom:<id>"`; resume is not
offered. `GET /v1/agents/custom` lists the stored agents whatever the licence
says, so a renewed licence restores them.

**Subscriptions** ([ADR-048](08-decisions.md)). A subscription is a sign-in
to Claude Code or Codex kept in `<data dir>/profiles/<id>/` (0700), stored as
`subscriptions: [{id, label, agent, created_at, plan?: {kind, label?,
usd_per_month?}}]` in `config.json`; `id` is eight lowercase hex digits. The
user's normal sign-in (`~/.claude`, `~/.codex`, or the directory their login
shell's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` names) is the **own sign-in**: never
stored, always listed first with `id: "default"` and `default: true` (the
field's name predates Make default and means "own"), and recorded on a
session as `""`. Its name is *Own sign-in* until renamed (`own_labels:
{agent: label}` in `config.json`). A `Subscription` in the API is `{id,
agent, label, default, preferred, plan?, dir, env_var?, signed_in, account?,
login_command, logout_command?, keychain_item?, windows: [{window,
used_percentage, resets_at, observed_at}], sessions_7d, cost_7d_usd, running,
created_at?, provider?}`. Each agent group may carry `ignored_env: [name]`.
`sessions_7d` and `cost_7d_usd` come from one sum of the last seven days
kept for a minute (`subSpendTTL`), so they can be up to a minute behind
while agents work; every other field is read on each request.

- **`provider: "deepseek"`** marks the one entry that is not a sign-in:
  Claude Code on DeepSeek, `id: "deepseek"`, listed last under `claude`
  while a DeepSeek key is set (`deepseek_api_key`) and absent otherwise.
  It has `signed_in: true`, `account: "your DeepSeek API key"`, `plan:
  {kind: "metered", label: "DeepSeek API"}`, an empty `dir` and
  `login_command`, no `windows`, and its own `sessions_7d`, `cost_7d_usd`
  and `running`. It is not in `config.json`'s `subscriptions`: it never
  counts toward `free_per_agent`, and `PATCH` and `DELETE` on it are `404`
  (the key is removed in `PUT /v1/settings`). The id cannot collide with a
  real one, which is hex.

- **`preferred`** marks, per agent, the one a new session starts on when the
  request names none — *Make default*, stored as `default_subscription:
  {agent: id}` in `config.json` (absent: the own sign-in, as before; an id
  that has been removed counts as absent, and `DELETE` drops it). It is
  Caprock's choice of directory for the sessions it starts: `~/.claude`, its
  credentials and the Keychain are never moved, rewritten or read, and a
  running session never changes account.
- **`plan`** is how that sign-in is paid for, as the user stated it in
  Settings → Plan & licence: `kind` `flat` or `metered`, the user's words,
  a monthly price (0 = not stated). Absent: the main plan (`plan_kind`,
  `plan_label`, `plan_usd_per_month` in `/v1/settings`) stands for it. The
  own sign-in has no `plan` of its own — the main plan is its plan, and the
  plan of every session no account plan is known for. Caprock never infers
  one (rule 6).

- **`signed_in` and `account` come from files, never from running the
  agent.** Claude Code: `oauthAccount.emailAddress` in the directory's
  `.claude.json` (the Default one's is `~/.claude.json`), or a
  `.credentials.json` beside it. Codex: `auth.json`, whose id token's `email`
  claim is decoded and nothing else kept. Plan windows stored for it also
  count as signed in (a Codex kept in the OS keyring leaves no file).
- **`login_command`** is the agent's own sign-in for the directory —
  `CLAUDE_CONFIG_DIR='<dir>' claude auth login` or `CODEX_HOME='<dir>' codex
  login`, `$env:…='<dir>'; …` on Windows — which the page types into a shell
  tab and the user runs. Caprock never runs it.
- **`logout_command`** is the agent's own sign-out pointed the same way
  (`claude auth logout`, `codex logout`), on added subscriptions only: Remove
  offers it first, because a credential in the macOS Keychain or the OS
  keyring is outside the folder `DELETE` removes. Caprock never runs it.
- **`keychain_item`** names, on macOS and for an added Claude Code
  subscription only, the Keychain item its sign-in is kept in: `Claude
  Code-credentials-` and the first eight hex digits of SHA-256 of the
  directory (NFC) — how Claude Code 2.1.302 names it, read from its bundle
  on 2026-10-18. A label for the user to find it by; Caprock never reads,
  writes or deletes it.
- **`ignored_env`** names the credential variables the login shell sets
  (non-blank) that a session on an added subscription runs without — see
  `POST /v1/agents` below. Names only, never values; absent when none is set.
- **`POST`** makes the directory and, for Claude Code, writes Caprock's hooks
  and status line into its `settings.json` (the same entries `caprock hooks
  install` writes into `~/.claude/settings.json`) and, when the user's own
  settings already carry `skipDangerousModePermissionPrompt: true`, that key
  too. Nothing else of the user's settings is copied. The daemon writes the
  same again at every start and before every spawn on it, so a moved shim
  follows. `400` for an agent other than `claude` or `codex`, an empty or
  over-40-character label, `Default`, or a label the agent already has;
  `402` when the agent already has `free_per_agent` (3, the Default one
  included) and the licence is not active; `403` from a paired device.
- **`PATCH`** changes what its body names: `label` (the same rules as
  `POST`, minus the free number; the own sign-in can be renamed too),
  `make_default: true`, and `plan` — an object sets it, held to what `PUT
  /v1/settings` holds the main plan to (`400` for another `kind` or a
  negative or non-finite price; the label is cut at 64 bytes), `null` or
  `kind: ""` clears it. `id` `default` needs `agent` (`claude` or `codex`)
  and refuses `plan` (`400`: its plan is the main one). `400` for a body
  that changes nothing, `404` for an unknown id, `403` from a paired device.
- **`DELETE`** removes it from the config and deletes its directory — only a
  directory directly under `profiles/`. `404` for an unknown id, `409` while
  a session Caprock started runs on it. Sessions recorded on it keep the id.
- **`GET`** is open to a controller phone (the start form's picker); the
  writes are not.

`POST /v1/agents` takes `subscription` (an id, `"default"` for the own
sign-in, or empty for the `preferred` one) for `agent` `claude` or `codex`.
The pickers send it whenever an agent has more than one sign-in, so an empty
one comes from a caller with no picker (an orchestrator task, a Telegram
`/new`, a phone on an older page). The daemon resolves it to the directory — the
request never names one — and the child gets `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` set to it, replacing any value the login shell exports; Claude
Code's folder trust is written to that directory's `.claude.json`, not
`~/.claude.json`. The variables that would make the agent use another
credential than the directory's are removed from that child's environment:
for Claude Code `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`,
`ANTHROPIC_FEDERATION_RULE_ID`, the
`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS}` switches and
`CLAUDE_SECURESTORAGE_CONFIG_DIR`; for Codex `CODEX_API_KEY` and
`CODEX_ACCESS_TOKEN` (`OPENAI_API_KEY` stays: Codex does not sign in with
it). A session on the own sign-in keeps them, except
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, which no session or shell tab Caprock
starts inherits (Claude Code sets it for its teammates; it moves the
Keychain entry off the configuration directory's). A `resume` runs on the subscription the session ran on,
whatever the request says, and is refused when that subscription has been
removed. An unknown id, or a subscription of the other agent, is `400`.

`subscription: "deepseek"` starts Claude Code on DeepSeek: the user's own
configuration directory (no `CLAUDE_CONFIG_DIR` is set), with the stored key
put into that child's environment only — never argv, the database, the
pty-host's registry or a log — as `ANTHROPIC_AUTH_TOKEN`, beside
`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` and
`ANTHROPIC_DEFAULT_SONNET_MODEL` `=deepseek-flash[1m]`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`
`=deepseek-flash`, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432` — DeepSeek's
published set for Claude Code (read 2026-10-13) less
`CLAUDE_CODE_EFFORT_LEVEL=max`. `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_SMALL_FAST_MODEL` and the
`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS}` switches are removed
from the login-shell environment for it. A `model` that does not start with
`deepseek-` is dropped, because the launcher's list is Claude's and DeepSeek
maps a Claude id to a model of its own choosing. `400` with no key set, or
for an agent other than `claude`; a `resume` of a DeepSeek session stays on
DeepSeek and is refused, saying why, once the key is removed. The session
records `sessions.subscription = "deepseek"`, so its plan windows, if Claude
Code ever reports any for it, go under `sub:deepseek:` and the plan-window
stop never pauses it.

The daemon reads each subscription's transcripts as it reads the Default
one's: Claude Code's under `<dir>/projects/`, Codex's under
`<dir>/sessions/` and `<dir>/archived_sessions/`. A hook or transcript line
whose transcript path is under `profiles/<id>/` records `sessions.subscription
= <id>`.

**`/v1/status`** carries `hermes` — `{sessions, events, unpriced?, background?,
last_poll_ms?}`, the Hermes Agent reader, absent while there is no Hermes
database — and `codex_available`, `opencode_available`,
`grok_available` and `hermes_available` beside `claude_available` and `gemini_available`: the binary
found on the daemon's PATH, the login shell's (once resolved — never waited
for), or the installers' directories (`~/.local/bin`, `~/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.opencode/bin`, `~/.grok/bin`, and
for an npm-installed CLI `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin` and
each nvm Node version's `bin`, newest first). `opencode_version` (`"2.0.26"`, omitted while unknown) is
what that binary's `--version` answered, asked in the background and cached
per file; OpenCode 1 and 2 are started with different flags, and the New agent
sheet words the permission modes by it ([16-opencode.md](16-opencode.md)).

**`POST /v1/agents` with `resume` is refused when the resume cannot work** —
`400 {error}` carrying the same reason `GET /v1/sessions/{id}` gives in
`resume.reason`. Otherwise a stale button started a `claude --resume` that
printed "No conversation found" and exited in a fresh terminal. An id the
store has never seen is let through.

**`GET /v1/sessions?q=&limit=`** — `q` searches project, cwd, branch,
`title`, `prompt`, the id, and **every** `turn.user` prompt of a session (not
only the first); SQLite's `LIKE` folds ASCII only, so the term is also tried
lowercased and with its first letter capitalised, which covers Cyrillic as it
is actually typed. `limit` defaults to 200 and is capped at 2000;
`X-Total-Count` counts what matches, so the Now screen can offer "show N more"
instead of leaving everything past the first page unreachable. `chats=exclude`
leaves chats out (the Now list, the phone's Continue) and `chats=only` lists
nothing else; absent, both are listed. `X-Total-Count` follows the same scope.

### Chats (HTTP)

A chat is a session Caprock started in one of its own chat folders,
`<data_dir>/chats/<YYYY-MM-DD-HHMMSS>[-N]` ([ADR-071](08-decisions.md)).
`Session` carries `chat: true` and `archived_at` (unix ms, omitted while 0);
both are omitted on any other session. `Spawn` marks a session whose `cwd` is
such a folder (`agents.IsChatDir`: a direct child of `chats/`, not a dot name).

```
GET    /v1/chats?q=&archived=1&limit=     → ChatList {items: [SessionSummary], total, chats, archived}
POST   /v1/chats/import                   body: an export → ChatImport (below; ADR-074)
PUT    /v1/chats/{id}/archived            {archived: bool} → {session_id, archived_at}
DELETE /v1/chats/{id}                     → {session_id, cost_usd, folder_removed}
GET    /v1/chats/{id}/files               → {files: [ChatFile], truncated?}
GET    /v1/chats/{id}/file?path=&download=1 → the file's bytes
```

- **The list.** Newest activity first; `archived=1` lists the archived ones
  instead. `q` searches as `GET /v1/sessions?q=` does. `limit` defaults to 100,
  at most 500. `total` counts what matches; `chats` and `archived` count all
  open and all archived chats, whatever `q` says, for the screen's counts.
- **Archive** sets or clears `archived_at` and publishes a `session` frame.
  `404` when the id is no chat, `400` without `archived`.
- **Delete** is for chats only (`404` otherwise). When the daemon holds the
  chat's terminal it is stopped first (`kill`, waited for up to four seconds);
  a chat still held, or `active` and not Caprock's, is `409` (rule 7). The row
  is then removed and tombstoned in one transaction, as `POST
  /v1/sessions/remove` does (§ Removing sessions), and the chat's folder is
  deleted when it is a chat folder no other session uses (`folder_removed`).
- **Files** lists the chat's folder: regular files only, no dot names, no
  `node_modules`, no symlinks, at most 500, newest first. A `ChatFile` is
  `{path, size, modified, kind}` — `path` relative with `/`, `modified` unix
  ms, `kind` one of `markdown`, `html`, `pdf`, `image`, `text`, `other`.
- **One file.** `path` must be a valid relative path with no `.` or `..`
  segment (`400`); after symlinks are resolved it must still be inside the
  folder (`403`); a missing file is `404`, anything but a regular file `400`,
  and one over 50 MB `413`. Headers: `X-Content-Type-Options: nosniff`, `Cache-Control:
  no-store`, the type from the extension, `Content-Disposition` inline or,
  with `download=1`, attachment. Every type but PDF also carries
  `Content-Security-Policy: default-src 'none'; img-src data: blob:;
  style-src 'unsafe-inline' data:; font-src data:; media-src data: blob:;
  sandbox`, so a chat's HTML opened directly runs no script and has no origin.
  PDF is left to the browser's own viewer. The dashboard draws HTML in an
  iframe with `sandbox=""` and the same policy as a `<meta>` in its `srcdoc`.
- **Who.** A paired viewer may list chats and read their files; a controller
  may also archive and delete them (§ Who may connect). Import is the
  machine's only.

**Imported chats** ([ADR-074](08-decisions.md)). A conversation from a
Claude.ai or ChatGPT export the user downloaded is stored as a chat that
nothing runs:

```
POST /v1/chats/import   body: the export's .zip, or its conversations.json → ChatImport
ChatImport {conversations, added, updated, unchanged, deleted, empty, messages, sources: {source: n}, error?}
```

- **The body** is the file's bytes, any `Content-Type`, at most 4 GB (`413`
  over). A zip is opened for its shallowest `conversations.json`; nothing
  else in it is read. The file is spooled to the OS temp directory and
  removed when the request ends. Nothing is sent anywhere (rule 4). Not an
  export, or empty: `400` with the reason. A conversation that cannot be
  read stops the import there; what came before it is kept, and the answer
  is `200` with `error` saying where it stopped.
- **The shapes.** Neither service documents its export; these are the
  fields open-source readers agree on (OQ-22, read 2026-10-17), every one
  optional. Claude.ai: an array of `{uuid, name, created_at, updated_at,
  current_leaf_message_uuid, chat_messages: [{uuid, parent_message_uuid,
  sender: human|assistant, text, content: [{type, text}], created_at,
  attachments: [{file_name}], files: [{file_name}]}]}`; only `text` blocks
  are prose, and the branch shown is the path from the root to
  `current_leaf_message_uuid` (export order without one). ChatGPT: an array
  of `{conversation_id|id, title, create_time, update_time (unix seconds),
  current_node, mapping: {node: {parent, children, message: {id, author:
  {role}, create_time, content: {content_type, parts}, metadata:
  {model_slug, is_visually_hidden_from_conversation}}}}}`; the branch is
  `current_node` back to the root, `user` and `assistant` messages only,
  hidden ones left out, an image part written `[Image]`, private-use
  citation markers removed. A message is clipped at 64,000 runes.
- **Storage.** No new table or column. The session is
  `claudeai-<uuid>` or `chatgpt-<id>`, with `agent` = `claude.ai` or
  `chatgpt`, `native_id` = the service's id, `chat = 1`, `status =
  'ended'`, `owned = 0`, no `cwd`, `title` = the conversation's name,
  `prompt` = its first message, `started_at` / `last_event_at` /
  `worked_at` from the export. Each message is a `turn.user` (`{prompt,
  imported_from}`) or `turn.assistant` (`{text, model?, imported_from}`)
  event with `source = 'import'`, key `imp:<message id>`, no tokens, no
  cost and `internal = 1`, so every aggregate leaves it out; no
  `session_stats` or `daily_stats` row is written.
- **Re-import** of the same or a newer export adds only messages whose key
  is new (`updated`), and leaves a conversation as it is otherwise
  (`unchanged`). A chat the user deleted keeps its tombstone and is not
  imported again (`deleted`). `empty` counts conversations with no message
  to show.
- **Read-only.** `resume` is `{ok: false, reason: "Imported from …"}`;
  `files` is `404` (no folder); archive, rename and delete work as for any
  chat (delete removes no folder).

**`resume`** — `{ok, reason?, command?, permission_mode?}`. `permission_mode`
is present only with `ok`: the mode `POST /v1/agents` will fill in for a
continue that names none (above), so the button can say it before the click;
absent when that is no mode at all. On the list it is filled for ended
sessions only, so a card can offer continue; on `GET /v1/sessions/{id}` for any
session except a live one Caprock started (that one is typed into) — unless
this daemon does not hold its terminal. Since
[ADR-033](08-decisions.md#adr-033--an-owned-session-outlives-the-daemon-its-terminal-lives-in-a-pty-host)
a restart reattaches the sessions it started, so such a session is one started
by a release from before pty-hosts, or one whose pty-host died, and it still has
a process; it is marked **`detached: true`**
on the list and the detail, and gets `resume` there too (FB-040): its terminal
tab used to open an empty screen. Continuing it under its own id
(`POST /v1/agents` with `resume` and no `fork`) first stops that terminal-less
process — SIGTERM, then SIGKILL after 5s; a kill on Windows — and only when the
row says Caprock started it (`owned`) and its recorded pid is alive, so two
processes never write one transcript (rule 7: it is Caprock's own process).

**`survives_restart`** — `true` on a live session Caprock started whose
terminal is in a pty-host, so restarting or upgrading Caprock leaves it
running; absent on one in the daemon's own PTY (the fallback), which ends with
the daemon. The upgrade notice counts only the latter. On the list and the
detail. Decided by what is on disk,
not by who started the session (FB-036): the agent (Claude Code, Codex and
OpenCode; Gemini is not continued), the cwd still existing, and for Claude Code
the main transcript
(`<project>/<session-id>.jsonl`, found from `transcript_path` or from the cwd's
Claude Code folder) still existing. `command` is offered whenever the agent has
one, including when Caprock cannot run it (folder gone, `claude` not found) —
except when the transcript is gone, where no command could work. Codex,
OpenCode and Hermes: `command` is `cd <cwd> && codex resume <id>` /
`opencode --session <id>` / `hermes chat --resume <id>` with the agent's own
id (`native_id` when set); `ok` is false while the session is not ended (two
processes on one thread), when its folder is gone, when Caprock started it and
nothing was ever sent (nothing to continue), when the binary is not found, or,
for Hermes, when its `state.db` is gone.

**`open_terminal`** — `{modes, reason?}`, filled wherever `resume` is: how the
session can be opened in the user's **own** terminal application (Ghostty,
iTerm2, Terminal, Windows Terminal, …), running the agent's resume command in
its folder. Absent for an agent with no command that reopens a session by id
(Gemini's `--resume` takes "latest" or an index, not an id; DeepSeek has none)
and when the daemon cannot open terminals. `modes` is what is allowed, the
first being what the main button does; empty, with `reason`, when nothing is.
The rule is [rule 7](../CLAUDE.md) as a table (`openTerminalModes`, tested as
one):

- **Ended** → `resume`, whoever started it.
- **Running, started by Caprock, and this daemon holds its terminal** → `move`
  (and `fork` for Claude Code). The process is Caprock's to stop.
- **Running anywhere else** — the user's own terminal, or a Caprock session
  whose terminal went with a restart → `fork` for Claude Code only; nothing for
  Codex and OpenCode, whose forks copy the history with its cost into a new
  session Caprock would count twice.

An ended Claude Code session whose transcript is gone, and an OpenCode session
whose folder is gone, get no modes and the reason. A Claude Code or Codex
session whose folder is gone opens from the home directory: both find a
conversation by id from anywhere.

**`POST /v1/sessions/{id}/open-terminal`** carries that out. `mode` defaults to
the first allowed; one that is not allowed is `409 {error}` with the reason;
`terminal` names one from `GET /v1/terminals` and defaults to the preferred
one. The command is the agent's own (`agents.NativeResume`), built from the
same resume arguments the dashboard's own launch uses (`agents.resumeArgs`,
shared with `argv.go`), without the flags Caprock adds for a PTY it runs:
`claude --resume <id>` (with `--fork-session` to fork), `codex resume <id>`,
`opencode --session <id>`, where the id is `native_id` for a Codex or OpenCode
session Caprock started. Such a session with no `native_id` sent nothing, so
it gets no modes and says so, as `resume` does. **`move`** stops Caprock's process first — `resume`
(a paused process cannot act on a signal), then `term`, up to
`agents.ShutdownGrace` for Claude Code to write its transcript out, then `kill`
— and only once this daemon no longer holds it does the window open, so two
processes never append to one conversation. The session's `owned` is then
cleared: it is the user's now, and would otherwise read as a Caprock session
whose terminal was lost. The launch is planned before anything is stopped, so a
refusal (no such terminal, an unsafe folder name) stops nothing. A failed
launch answers `400` (no terminal, unsafe input) or `502` with `{error,
command}` — the command, so the screen can offer it to copy. Session ids and
command words are checked against a plain charset, a folder name with a control
character (or a `"` on Windows) is refused, and everything else is quoted for
the shell it reaches ([02-architecture.md](02-architecture.md#native-terminals)).
Both endpoints are closed to a paired device: one is a `POST`, and
`GET /v1/terminals` lists this machine's applications, which a tablet has no
use for (ADR-029).

`GET`/`PUT /v1/settings` carry **`terminal`**, the id of the terminal sessions
open in; empty means the first installed. `PUT` accepts only an id this build
knows for its OS (`nativeterm.IDs`) or `""`, else 400. Stored as `terminal` in
`config.json`.

**Open in editor** (F18, `internal/editor`, `internal/api/editor.go`).
`GET /v1/editors` lists the editors installed here, in the order they are
offered — VS Code, Cursor, Zed, then the JetBrains IDEs (IntelliJ IDEA,
GoLand, WebStorm, PyCharm, RustRover, PhpStorm, CLion, Rider, RubyMine) —
found once per daemon run: app bundles in `/Applications`, `~/Applications`
and `~/Applications/JetBrains Toolbox` on macOS, executables on the login
shell's `PATH` on Linux, none yet on Windows (its launchers are batch files).
`preferred` is the `editor` setting when that one is installed, else the
first. `POST /v1/editors/open` `{path, line?, editor?}` opens an absolute,
clean, existing `path` (no control characters; a `line` only for a file,
1–10,000,000) and answers `{editor}`; a bad path or a missing editor is
`400`, a launch that fails `502`. Each launch is an argv, never a shell
string, and the path is its own word: macOS `open -a <bundle> <path>`, or
with a line the bundle's CLI (`code -g <path>:<line>`, Zed's `cli
<path>:<line>`) and for JetBrains `open -na <bundle> --args --line N <path>`;
Linux the executable with the same arguments. Both endpoints answer `403` to
anything but a request from this machine (`isLocal`: loopback and not
relayed), in the handler, whatever a device's role — an editor opens on this
screen, not the phone's — and neither is on a device allowlist.
`GET`/`PUT /v1/settings` carry **`editor`**: an id from `editor.IDs()` or
`""` (the first installed), else 400; stored as `editor` in `config.json`.

**Open a link in a browser** (the terminal link chooser, `internal/browser`,
`internal/api/browser.go`). `GET /v1/browsers` lists the web browsers
installed here, found once per daemon run from what the OS says handles web
links, the default first and the rest by name: on macOS every app
LaunchServices names for an https URL (`LSCopyApplicationURLsForURL`, the
default from `LSCopyDefaultApplicationURLForURL`, through purego), kept only
inside an Applications folder and not inside another bundle, `id` the
bundle's path; on Windows the registry's `Clients\StartMenuInternet` keys
(HKCU, then HKLM, each also under `WOW6432Node`) with a `shell\open\command`
whose executable exists, `id` the key's name, the default the one whose
`Capabilities\URLAssociations\https` ProgId is the https `UserChoice`; on
Linux the desktop entries in the XDG data dirs (plus Flatpak's and Snap's
exports) whose `MimeType` names `x-scheme-handler/http` or `https`, shown and
with their `TryExec` installed, `id` the desktop file id, the default from
`mimeapps.list` (the desktop-specific one first, then the config and data
dirs, then `defaults.list`). Of what the OS names, only the web browsers
`internal/browser/known.go` knows are listed — by bundle id or app name on
macOS, executable, StartMenuInternet key or display name on Windows,
desktop file id or `Name` on Linux — and the default always, known or not:
an app that merely registers for https (a chat app, a terminal, an editor,
a bank's "secure browser" wrapper) is left out, and `POST /v1/browsers/open`
refuses its id as unknown. `POST /v1/browsers/open`
`{browser, url}` opens an `http` or `https` `url` (a host, no spaces or
control characters, at most 8 KiB) in that browser and answers `{browser}`;
a bad URL or an unknown browser is `400`, a launch that fails `502`. Each
launch is an argv, never a shell string, and the URL is its own last word:
macOS `open -a <bundle> <url>`, Windows the client's executable with the URL,
Linux the entry's `Exec` with `%u` (`%U`, `%f`, `%F`) replaced by the URL
and the other field codes dropped. Both endpoints answer `403` to anything
but a request from this machine (`isLocal`), in the handler, and neither is
on a device allowlist.

`GET`/`PUT /v1/settings` carry **`spawn_permission_mode`**: the permission mode
new sessions start in, one of `agents.PermissionModes` (`acceptEdits`, `auto`,
`bypassPermissions`, `dontAsk`, `manual`, `plan`) or `""` for not set, else
400; stored as `spawn_permission_mode` in `config.json`. The new-session
dialogs open on it, and `POST /v1/agents` uses it for a request with no mode
and nothing to carry one from.

**`SessionSummary.description` / `description_source`** — what tells a session
from the others on the screen (FB-035): the name the user gave it,
`sessions.name` (`"name"`), else the stored `sessions.title`
(`"title"`), else the first of the session's earliest eight `turn.user`
prompts — or the stored `sessions.prompt`, for Codex — that says something (`"prompt"`):
not a tag-wrapped command or notification, not a bare path, at least 12
characters. First line only, clipped to 120 characters.

**Non-Anthropic pricing.** `pricing/pricing.json` carries rows for the models Caprock observes through OpenCode — DeepSeek and MiniMax at the providers' own published rates, fetched with a date and noted in the file. They are priced so a total that includes non-Anthropic usage is a total; before this, $155 of the owner's own spend sat outside his. `normalizeModel` strips a gateway's vendor prefix, so `minimax/minimax-m3` from OpenRouter and `MiniMax-M3` from the direct API are one row rather than two, one of them unpriced. The unpriced warning fires only on turns whose tokens are greater than zero: a turn recorded with explicit zeroes has nothing to price, and warning about it says a total is missing money it is not missing.

### Projects and shells (desktop app, WP-05, WP-07, WP-08)

The desktop app's sidebar ([21-app.md § Projects](21-app.md#projects)). Code:
`internal/projects`, `internal/agents/worktree.go` and `shell.go`,
`internal/api/projects.go`. State-changing requests need
`Content-Type: application/json`, `DELETE` included (§ Cross-site request
protection).

```
GET    /v1/projects                        → {projects: [Project]}; pinned first, then sort, then name
POST   /v1/projects                        {path, repos?, name?} | {repos, name?} | {create: {parent, name, git_init?}} | {clone: {url, parent, name?}, op_id?}
                                           path, create → 200 {project, created}; clone → 202 {op, existing}
GET    /v1/projects/ops                    → {ops: [Op]}; clones and template ops running or ended in the last hour, newest first
GET    /v1/projects/scan?path=             → ScanResult; what adding a folder would add (machine only)
POST   /v1/projects/merge                  {ids: [id, id, …]} → {project}; one multi-repo project (machine only)
PATCH  /v1/projects/{id}                   {name?, pinned?, sort?, defaults?: {agent?, model?, permission_mode?, system_prompt?, setup_command?}, repos?} → {project}
GET    /v1/projects/{id}/repos             → {repos: [RepoView]}; a multi-repo project's members, with open pull requests
POST   /v1/projects/{id}/split             → {projects: [Project]}; one project per member, this one unlisted (machine only)
DELETE /v1/projects/{id}                   → 204; unlists it: nothing on disk is touched, no session or cost changes
GET    /v1/projects/{id}/worktrees         → {worktrees: [Worktree]}
POST   /v1/projects/{id}/worktrees         {branch, create?, base?} → {worktree: {path, branch, tracks?, copied?}}
GET    /v1/projects/{id}/branches          → {branches: [{name, main?, default?, local?, remote?, committed_ms}]}
DELETE /v1/projects/{id}/worktrees/{name}  → 204; 409 {error} when it has any change
GET    /v1/projects/{id}/copies            → {copies: [Copy], default_branch?, has_remote, total, pending?, capped?}
POST   /v1/projects/{id}/copies/remove     {copies: [{path, force?}], delete_merged_branches?} → {results: [{path, removed, branch_deleted?, confirm?, error?}]}
GET    /v1/projects/{id}/cleanup           → CleanupView
POST   /v1/projects/{id}/cleanup           {paths: [path]} → {results: [{path, removed, confirm?, error?}], cleanup: CleanupView}
POST   /v1/projects/{id}/cleanup/restore   {ids: [id]} → {results: [{id, path?, restored, error?}], cleanup: CleanupView}
POST   /v1/shells                          {cwd | project_id, cols?, rows?, replaces?, type?, run?} → {shell: Shell}
GET    /v1/shells?project=<id>             → {shells: [Shell]}; every running shell without project
WS     /v1/live "shells" frame             → {shells: [Shell]}: every running shell, after a start and when the list changed
```

- **The `shells` frame** (2026-10-19) is `GET /v1/shells`' answer without
  `project`, sent by `POST /v1/shells` once it has started one and by a check
  every 10 s while a `/v1/live` client is connected, only when the list
  (a shell's `program` included) differs from the last one sent. The app
  follows it and asks `GET /v1/shells` on mount and once a minute as the
  fallback for a daemon before it; it asked every 10 s. Code:
  `internal/api/projects.go` (`PublishShells`), `internal/daemon/livepush.go`.

- **`Project`** — `{id, name, root, kind: "repo"|"folder", source:
  "seed"|"session"|"folder"|"new"|"clone", pinned, sort, added_at, archived?,
  exists, defaults, git, sessions: {live, waiting, total}, cost_today,
  last_activity, worktrees: [Worktree], repos?: [RepoView], instruction_files?: [string],
  removed?}`. `instruction_files` are the repository's own instruction files
  for agents — `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md` — that are
  regular files at `root`, then each existing member's below it as
  `<member>/<file>` (a stat each per view, nothing read; read one through
  `GET …/file`); absent when there are none (2026-10-14). `root` is in the OS's own
  form (backslashes on Windows), so it can be sent back as a `cwd`. `git` is
  `null` for a folder and otherwise `{branch, detached?, dirty, changed,
  ahead, behind, upstream?, default_branch?, remote_url?, error?, at}`:
  `changed` counts modified, staged, conflicted and untracked files; `at` is
  when git last answered (0 until the first answer); `error` is git's own
  message, or the timeout, with the last good figures kept. `sessions` and
  `cost_today` count the sessions whose repository root (else cwd) lies in
  `root`, the longest listed root winning: `live` is not ended, `waiting` is
  live with a main-thread `agent.stop` or a `permission.prompt` as its newest
  event, and `cost_today` is the non-internal events since local midnight. A
  `project` frame with `removed: true` and only `id` is sent on unlisting.
- **Multi-repo projects** (2026-10-12, [ADR-055](08-decisions.md);
  2026-10-18, [ADR-077](08-decisions.md); `internal/projects/multirepo.go`,
  `internal/api/multirepo.go`). A project with member repositories
  (`project_repos`, migration 0050); `repos` is absent for an ordinary
  project. Its `root` is either a folder holding them (`kind: "folder"`,
  ADR-055) or one of them, its **home repository** (`kind: "repo"`,
  ADR-077), which is then a member too: `repos` lists it beside the others.
  No new column or kind: the home form is a repository project with members.
  - **`ScanResult`** — `{root, repo_root?, repos: [{path, name, project_id?,
    project_name?, member_of?, instruction_files?}], capped?,
    instruction_files?: [{name, text, truncated?}]}`. The top-level
    `instruction_files` are those at the top of `repo_root`, else of `root`,
    with their text (64 KB each at most, cut on a rune boundary; one that is
    not UTF-8 or holds a NUL is left out), so the app can show them before
    the project is added; each found repository names its own (2026-10-14). `repo_root` is set when the folder
    is inside a repository (nothing to choose); otherwise `repos` are the
    folders with a `.git` at most two levels below, sorted by path, `name`
    the path below `root` with `/`. A repository is not descended into;
    hidden folders, `node_modules`, `vendor`, `Pods`, `__pycache__` and
    `target` are skipped, symbolic links to folders followed, and below a
    folder macOS does not guard a guarded one is not opened. At most 4,000
    folders opened and 200 repositories (`capped`). `project_id` marks a
    repository listed on its own, `member_of` one in a multi-repo project.
  - **Adding** `{path, repos}` lists `path` (an existing folder, not inside a
    repository) as one project of `repos` — two or more, each a folder inside
    a repository, which names that repository's root; at most 100. A
    repository listed as a project of its own is unlisted (folded in); one
    that was another project's member moves. `name`, when set, names it.
  - **Adding** `{repos, name?}` (no `path`; 2026-10-18, ADR-077) lists one
    project of `repos` — two or more, at most 100, each a folder inside a
    repository, anywhere — with no folder of its own: the first is its home
    repository, the project's `root`, and every one is a member. The home
    repository's own project, when listed (or unlisted before), is the row
    used: `created: false`, its settings, history and id kept, renamed to
    `name` when set. Others listed on their own are folded in as above. One
    repository is `400`; from a paired controller every path must be
    absolute and under home (`403`). Nothing on disk is made or moved.
  - **`PATCH` `repos`** replaces the members whole (`[]` makes the project
    an ordinary one again); a folder project's own folder cannot be one. On a
    repository project (*Add a repository…*, ADR-077) its own root is kept
    among the members whenever another is named, and a list naming no other
    makes it ordinary; a repository project left holding only its own root
    after a member moved to another project becomes ordinary too. A removed
    member is neither deleted nor listed. From a paired controller every path
    must be absolute and under home (`403`).
  - **Split** (`POST /v1/projects/{id}/split`) lists each member as a project
    of its own and unlists the project — except a home repository's: that
    project stays, as the repository alone, under its name. **Merge**
    (`POST /v1/projects/merge {ids}`) of repository projects only keeps the
    first, its repository the home one, the others members (until
    2026-10-18 it listed the folder holding them all, which for two
    repositories in `~/dev` was `~/dev`); with a multi-repo project among
    them, that project takes the others' repositories, as before.
  - **`RepoView`** — `{path, name, exists, git: GitStatus | null, sessions:
    {live, waiting, total}, cost_today, last_activity, open_prs?,
    prs_error?}`. `git` is null until git first answers.
  - **Attribution.** A session's directory key (repository root, else cwd)
    goes to the project whose root or member holds it most closely, the
    longest path winning and a member winning a tie; the project's
    `sessions` and `cost_today` include its members and its folder, and each
    member's `RepoView` its own share. `projects.ProjectFor` (instructions,
    setup command) follows the same rule.
  - **Agents.** A session Caprock starts in a multi-repo project gets every
    member that neither holds its folder nor lies inside it, and exists:
    Claude Code `--add-dir=<path>`, Codex `--add-dir <path>`, Gemini
    `--include-directories=<path>`; OpenCode and Grok none. Every Claude Code
    `--add-dir` (Caprock's own folders included) is written `--add-dir=<path>`:
    the flag is variadic and would otherwise take a following positional
    prompt as a directory (read in 2.1.296).
  - **Git state.** Members are never watched. One `git status` per member on
    add, on edit, at daemon start, 2 s after an agent's edit tool in it, and
    on `GET …/repos` when its last answer is older than 30 s; each sends a
    `project` frame. `GET /v1/projects` runs no git for members.
  - **Open pull requests** are read on `GET …/repos` only, for members whose
    `origin` is on github.com while GitHub is connected: `GET
    /repos/{o}/{r}/pulls?state=open&per_page=100` (conditional), the count
    kept 60 s per repository. `prs_error` says why there is none.
  - **Split** relists each member as a repository project (one unlisted
    before keeps its name and settings), clears the members and unlists this
    project. **Merge** takes repository projects and at most one multi-repo
    project: their repositories become the members of the multi-repo one,
    or of a new project at the deepest folder holding them all — refused when
    that is the home folder or a filesystem root; the others are unlisted.
    Neither touches a file. `GET …/repos` is open to every paired device;
    scan, split and merge to none.
- **`Worktree`** — `{name, path, branch?, head?, caprock, locked?, missing?,
  dirty, changed, error?}`, read from `<git common dir>/worktrees/*` without
  running git; `caprock` is true for one under `<root>/.caprock-worktrees/`.
- **Adding.** `path` must be an absolute folder; a folder inside a repository
  lists the repository root. Adding a listed root returns it (`created:
  false`); an unlisted one is listed again with its old name and settings.
  `create` makes one folder `name` (one plain segment) in an existing
  `parent`, refuses one that exists, and runs `git init` when `git_init`.
  `clone` takes an `https://` URL or `user@host:path` and nothing else (no
  local path, `file://`, `ssh://`, `ext::`, leading `-` or whitespace), into
  `parent/<name>` (default: the URL's last segment without `.git`), refused
  when that exists — unless it is an empty folder, hidden files included,
  which git clones into as it would (2026-10-09). A missing `parent` is created first, as `git clone` makes
  the folders on the way to its destination. In `path`, `create.parent` and
  `clone.parent` a leading `~` is the home folder. It runs `git clone --progress` in the background with the
  login shell's environment and `GIT_TERMINAL_PROMPT=0`, for the daemon's
  life, not the request's. A `POST` whose `op_id` (`[A-Za-z0-9_-]{1,64}`,
  generated when absent) is already known returns that operation with
  `existing: true` and starts nothing.
- **`Op`** — `{op_id, kind: "clone"|"template", state: "running"|"done"|"failed", phase?,
  progress, url, dest, project_id?, error?, started_at, updated_at}`; a
  `template` op also carries `step`, `repo?`, `repo_url?`, `notes?`,
  `retryable?` and `removed?` (§ Project templates). `phase`
  and `progress` (0 to 100 within the phase) are git's own ("Receiving
  objects", "Resolving deltas"); an `op` frame goes out per step, at most four
  a second plus the last. `error` is the last lines git printed. Kept in
  memory for an hour after it ends; a daemon restart forgets them.
- **Worktrees.** `POST` puts the worktree at
  `<root>/.caprock-worktrees/<branch, / made ->` and adds
  `/.caprock-worktrees/` to the repository's `.git/info/exclude` (never a
  tracked file), so the main checkout does not read as changed. An existing
  local branch is checked out; a branch only one remote has is created
  tracking it (`tracks`); `create` makes a new branch from `base` (default
  `HEAD`) and refuses an existing one. A branch checked out elsewhere is
  refused with git's own message (`400`). `DELETE` removes only a worktree
  under `<root>/.caprock-worktrees/`, never with `--force`: any change,
  untracked included, is `409`; the branch is kept; a name with a separator
  is `400`.
- **Copies** (2026-10-11; `internal/projects/copies.go`,
  `internal/api/copies.go`). `GET …/copies` lists `git worktree list
  --porcelain`, the main checkout first, so worktrees made by hand are listed
  too. **`Copy`** — `{name?, path, main?, branch?, head?, detached?, caprock,
  locked?, missing?, committed_at?, merged, unpushed, orphaned?, dirty,
  changed, live: [string], size, size_capped?, error?}`: `path` is in the OS's
  own form, spelled under the project's `root` as the project is (git prints
  symlinks resolved); `committed_at` is the newest commit, Unix seconds;
  `merged` is HEAD being an ancestor of `refs/heads/<default>` or
  `refs/remotes/origin/<default>` (never for the main checkout or the
  default branch itself; a squash merge is not seen); `unpushed` is `git
  rev-list --count HEAD --not --remotes`, read only when the repository has
  a remote (`has_remote`); `orphaned`, for a detached HEAD, counts commits no
  branch or remote holds; `live` names every session not ended whose `cwd`
  is in the copy and every shell tab started there. `size` is bytes, `null`
  while measured and always for the main checkout and a missing folder. Sizes
  are measured in the background, one folder at a time, by walking it
  without following links, stopping at 300,000 entries or 20 s (`size_capped`:
  a floor), and kept for 10 minutes; a stale size is served while it is
  measured again. `total` sums the known sizes of the linked copies,
  `pending` says some are not known yet, `capped` that some are floors. Up to
  two copies are inspected at once, each by a handful of git commands under
  the usual timeout.
- **Removing copies.** `POST …/copies/remove` takes 1 to 200 paths and
  judges each again at that moment: the main checkout, a path that is not
  one of the project's worktrees, a copy not under `<root>/.caprock-worktrees`,
  a locked one, and one with anything in `live` are refused with the reason
  in `error`. A copy with uncommitted changes (untracked included), unpushed
  commits or orphaned commits is refused with `confirm: true` and what it
  would lose, unless the item says `force`. Removal is `git worktree remove`,
  with `--force` only for a forced item or a missing folder. With
  `delete_merged_branches` the copy's local branch is then deleted (`git
  branch -D`, after checking it is an ancestor of the default branch as for
  `merged`); an unmerged branch, the default branch and a detached copy keep
  theirs. The answer is `200` with one result per item; `400` for a body
  outside those bounds or a project that is not a repository. Both routes are
  loopback only: neither is on a paired device's or a controller's list.
  Every copy removed here is added to the cleanup history (`how: "manual"`).
  `Copy` also carries **`stale?`**: a copy Caprock made whose newest commit
  is over 14 days old and whose branch has no pull request in the cached
  list (below); a suggestion, never a reason to remove it.
- **Finished copies** (2026-10-13; `internal/projects/cleanup.go`,
  `internal/api/copies.go`). A copy is *finished* — a candidate — when it is
  under `<root>/.caprock-worktrees`, not missing or locked, nothing is in
  `live`, it has no change (untracked included), no `git error`, is on a
  branch other than the default, has no orphaned commit, and either `merged`
  holds and the branch's reflog has more than its creation entry (a fresh
  copy never committed in is merged trivially and is not finished), or the
  branch's pull request is `merged` in the Branches view's cached list
  (`github.CachedBranchPR`; nothing is sent) with its `head_sha` equal to
  the copy's HEAD — a squash merge. With a remote, `unpushed` must be 0
  unless that pull request's head is the copy's HEAD. A restored copy is not
  a candidate again until its HEAD moves. The mode is
  `worktree_cleanup` in `/v1/settings`.
  **`CleanupView`** — `{mode: "off"|"ask"|"auto", candidates:
  [{path, branch, size, size_capped?, since, due?, pr?}], total, pending?,
  removed: [CleanupRecord], history: [CleanupRecord], checked_at}`: `since`
  is when it became a candidate (Unix ms, kept across restarts); `due`, in
  Auto mode, is `since` + 24 h; `pr` is the merged pull request when git
  alone did not see the merge; sizes come from the copies' size cache.
  `removed` are the records of the last 24 h with `how` `auto` or `ask`, not
  restored (the "Removed · Undo" line); `history` is the project's last 20,
  newest first. **`CleanupRecord`** — `{id, project_id, path, branch?,
  head?, bytes, at, how: "auto"|"ask"|"manual", branch_deleted?,
  restored_at?, settled?, restorable}`; `restorable` is within 7 days, not
  restored and the folder free. In mode `off` `candidates` is empty and
  `POST …/cleanup` is `400`.
- **When it is checked** — never on a poll: a session whose `cwd` is in a
  `.caprock-worktrees` folder ending (its project, after 5 s); a fresh read
  of the Branches view's pull request list showing a branch merged that the
  last read did not (`github.Service.OnMerged`; each project with a copy of
  Caprock's on that branch); the mode changing; and a daily pass, the first
  10 minutes after start, over the projects with a copy of Caprock's in the
  git state already held. The first `GET …/cleanup` after a start checks the
  project; later ones answer from the last check. In Auto mode a candidate
  whose `due` has passed is removed (judged again as `copies/remove` would,
  never forced, its branch kept) and a timer is set for the next `due`.
- **`POST …/cleanup`** removes exactly the listed paths among the copies
  that are finished at that moment (a path that is not is kept, with the
  reason), never forced, branches kept; recorded with `how: "ask"`.
  **`POST …/cleanup/restore`** puts records back: `git worktree add <path>
  <branch>`, or `git worktree add -b <branch> <path> <head>` when the
  branch is gone, then the `.worktreeinclude` files; refused once restored,
  after 7 days, outside `.caprock-worktrees`, or with the folder present.
  The daily pass deletes the branch of a record cleaned up (`auto` or `ask`)
  7 days earlier and not restored, but only while the branch still points at
  `head`, no worktree has it checked out and it is merged (or its pull
  request is, at `head`); any other branch is left for good, and a `manual`
  record's branch is never touched. All three routes are loopback only.
- **State file**: `<data_dir>/worktree-cleanup.json` — `{since: {pathKey:
  ms}, kept?: {pathKey: head}, removed: [CleanupRecord]}`, written
  atomically; records older than 30 days go (one still inside its 7 days
  stays), at most 200. No DDL.
- **From a controller phone**, `path`, `create.parent` and `clone.parent`
  must be absolute and resolve under home (`403` otherwise), and the worktree
  routes refuse a project whose root is outside home. The `GET` routes are
  open to every paired device; the shell routes to none.
- **`defaults.system_prompt`** is a project's instructions for its agents,
  trimmed, at most 16 KiB, no NUL. A Claude Code session Caprock starts in a
  folder inside the project (`projects.ProjectFor`, the longest root) gets
  `--append-system-prompt <text>`, a Codex one
  `-c developer_instructions="<text>"` (quoted as TOML), a Grok one
  `--rules <text>`, on a start and a resume; OpenCode and Gemini ignore it. `defaults` is replaced whole by a PATCH, so a client sends the
  other keys back with it (`instructionsPatch`).
- **`defaults.setup_command`** (2026-10-11, [ADR-050](08-decisions.md)) runs in
  a worktree created for an agent being started (`POST /v1/agents` with
  `worktree`), before the agent, in its terminal; never in a worktree that
  already existed. Trimmed, at most 4 KiB, no NUL. A paired device's PATCH
  that would set, change or clear it is `403`; one that carries it through
  unchanged is not (`setupPatch` on the client).
- **`.worktreeinclude`** (ADR-050): every worktree Caprock creates — `POST
  /v1/projects/{id}/worktrees` and a spawn's `worktree` — gets the files of
  the checkout it was made from that match the patterns in that checkout's
  `.worktreeinclude` (gitignore syntax) **and** that git ignores. Never an
  overwrite, never outside the worktree, symlinks only relative and inside the
  repository, at most 5000 files and 256 MB. `copied` on the worktree `POST`
  says what came along (*copied 2 files from .worktreeinclude (.env,
  .env.local)*), or why not; absent when nothing matched.
- **`caprock worktree-setup -- <agent> <args…>`** (hidden) is the process a
  session with a setup command starts as. It reads `CAPROCK_SETUP_COMMAND`,
  `CAPROCK_SETUP_TIMEOUT` (seconds, default 600) and `CAPROCK_SETUP_NOTE`
  from its environment and removes them, prints the note, runs the command
  (`/bin/sh -c` in its own process group; `cmd.exe /d /s /c` on Windows) with
  no input, prints the outcome, writes `ESC ] 777 ; caprock-setup-done BEL`,
  then execs the agent (Windows: runs it in a kill-on-close job and exits
  with its code). Ctrl+C stops the command, the timeout stops its process
  tree, and either way the agent starts. The session records the agent's own
  command, not the wrapper's.
- **`type`** on `POST /v1/shells` (ADR-046) is one line typed at the new
  shell's prompt once the shell has drawn it and gone quiet, never followed by
  Enter: an agent's install or sign-in command that the user reads and runs.
  Anything from the first line break on is dropped; ignored with `replaces`.
- **`run`** on `POST /v1/shells` (2026-10-11, [ADR-051](08-decisions.md))
  presses Enter after `type`, on its own write 80 ms later: a saved command
  the user picked to run. Still one line: anything from the first line break
  on is dropped, so what runs is what the user saw.
- **`replaces`** on `POST /v1/shells` names the session whose program exited
  and whose tab the shell takes over. Every window showing that tab asks; the
  first starts the shell and the rest get the same one while it runs. The map
  is the daemon's memory only and forgets a shell once it has ended.
- **`Shell`** — `{id, cwd, command, started_at, survives_restart, project_id?,
  program?, internal: true, kind: "shell"}`. **`program`** is what runs in
  front of the shell's prompt — `"claude"`, `"npm"`, `"vim"`, the program's
  argv[0] base name (not the kernel's short name: Claude Code's native binary
  is a file named after its version) — and is absent while the shell sits at
  its prompt. On macOS and Linux it is the terminal's foreground process group
  read from the shell's own process (`tpgid` from `kern.proc.pid` or
  `/proc/<pid>/stat`): a group other than the shell's is a running job, named
  by its leader, or `"program"` when no member can be named. On Windows it is
  the shell's first child process other than a console host, best effort; a
  child is a process naming the shell's pid as its parent *and* created no
  earlier than the shell (Windows never clears a dead parent's pid and reuses
  it, so csrss otherwise claims any process that draws its boot-time
  parent's pid). It may be absent while something runs, and reading it never
  fails the list.
  It is read only for a running shell Caprock started, at most once per 2 s
  per shell however often the list is asked (`internal/fgproc`,
  `Manager.ShellProgram`); reading signals nothing (rule 7). The app ends an
  idle shell whose tab is closed and asks first about a busy one
  ([21-app.md § Shell tabs](21-app.md#shell-tabs)). The user's login shell — `$SHELL -l` from
  the login environment on POSIX; `pwsh.exe -NoLogo`, else `powershell.exe
  -NoLogo`, else `%ComSpec%` on Windows — under a pty-host with `meta.kind =
  "shell"`, so it outlives the daemon like an agent session. Its terminal,
  input, resize and kill are `/v1/agents/{id}/term`, `input` and `signal`.
  **A shell is not a session:** it writes no `sessions` row and no event, so it
  is in no total, Now card, export or count (`/v1/status`'s `owned_active`
  included), and the daily spend cap never pauses one. A restart reattaches it
  from its registry entry and writes nothing to the store.
- **Seeding.** On the first start with migration 0041, every
  `sessions.repo_root` that is still a folder with a `.git` directory of its
  own, is not `NotAProject`, is not under a temp directory and is not under
  `.caprock-worktrees` is listed (`source: "seed"`); one folder under two
  spellings (a symlink) is listed once. `meta.projects_seeded = "1"` stops it
  running again. After that, a session in a repository not yet listed lists
  it by the same test (`source: "session"`). An unlisted root is never listed
  again by either.
- **Git state.** fsnotify watches each repository's git dir (HEAD, index,
  packed-refs, FETCH_HEAD, config), its `refs/heads` tree, `worktrees/` and
  each linked worktree's git dir, never objects or logs; attribute-only
  (chmod) events and `*.lock` files are ignored. A change is debounced 300 ms,
  then `git --no-optional-locks status --porcelain=v2 --branch` runs under a
  5 s timeout, at most two at once, for the part that changed only (the main
  checkout, or one linked worktree). Remote URL, default branch
  (`refs/remotes/origin/HEAD`, else `main` or `master`) and the worktree list
  are read from files. An agent's `tool.post` of an edit or shell tool asks
  git again after 2 s; a session starting, stopping, asking or ending sends a
  `project` frame after 1 s. Nothing runs on a timer: idle projects run no git.

### Project templates

New project from a template (2026-10-15, [ADR-065](08-decisions.md)). Code:
`internal/templates`, `internal/api/templates.go`. Every route is the
machine's: none is on a paired device's or a controller's list, so a phone
gets `403` from the gate, reading the list included. Free. State-changing
requests need `Content-Type: application/json` (§ Cross-site request
protection).

```
GET    /v1/templates                     → {templates: [Template], gh: GHStatus}
POST   /v1/templates                     {name, github?, folder?, brief_path, prompt, agent?} → {template}
PATCH  /v1/templates/{id}                {name?, github?, folder?, brief_path?, prompt?, agent?} → {template}
DELETE /v1/templates/{id}                → 204; off the list, nothing on disk or GitHub touched
POST   /v1/templates/inspect             {github} | {folder} → Inspection
POST   /v1/projects/from-template        CreateRequest → 202 {op, existing}
POST   /v1/projects/ops/{op_id}/retry    → 202 {op}
```

- **`Template`** — `{id, name, github?, folder?, brief_path, prompt, agent?,
  created_at, used_at?}`. `id` is 8 lowercase hex. `name` is trimmed, 1 to 80
  characters, no control character. A template is a GitHub repository, a
  folder on this machine, or both: `github` is `owner/name`
  (`^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`, the name not `.` or `..`);
  `folder` is an absolute path to an existing folder (a leading `~` is the
  home folder; one moved away after it was saved stays on the list).
  `brief_path` is where the brief is written in the new project: relative,
  forward slashes, no `..`, `.` or empty segment, no leading `/` or `\`, no
  backslash, no drive letter, not into `.git/` (any case), each segment a
  plain folder name that no OS refuses (no `:*?"<>|`, no control character,
  not ending in a dot or a space, not a Windows device name such as `CON` or
  `LPT1.txt`), at most 256 bytes. `prompt` is the first prompt for the
  agent, at most 8 KiB, no NUL; `{brief}` is its only variable and the
  client replaces it with `brief_path` when it starts the agent (any other
  `{word}` is `400`; `POST /v1/agents` takes at most 8,000 runes of it). `agent` is one Caprock can start. `used_at` is the
  last project made with it (matched by `template_name`). A `PATCH` sends
  only what changes; `""` clears `github`, `folder` or `agent`. `400` with
  the reason for anything outside these bounds, `404` for an unknown id.
- **`GHStatus`** — `{installed, logged_in, login?, error?}`: whether the
  person's own GitHub CLI is on the login shell's `PATH` (else Homebrew's
  places) and signed in, read with `gh config get -h github.com user` —
  gh's own config on this machine; nothing is sent to GitHub and the token
  is never read. `error` says what to do (`gh auth login`).
- **List.** At most 50 (`400` past it), empty until the person adds one;
  nothing is built in. **State file**: `<data_dir>/project-templates.json`
  — `{templates: [Template]}`, written atomically
  (`config.WriteFileAtomic`, 0600). A file that is not that JSON is renamed
  `project-templates.json.bad-<unix ms>`, logged, and the list starts empty;
  an entry that no longer passes the checks is dropped and logged. No DDL.
- **`Inspection`** — `{github?, folder?, is_template?, visibility?,
  template_md, brief_path, brief_from: "marker"|"mention"|"default", prompt,
  prompt_from: "marker"|"default", local_folder?, suggested_name, error?}`,
  read on the click that asks, to fill in the form. For `github` (the
  person's gh, signed in): `gh repo view <o/n> --json
  isTemplate,visibility,nameWithOwner` — `github` comes back as
  `nameWithOwner`, so a renamed or moved repository (`cybrixcc/corpus` →
  `dspv/corpus`) is saved under its canonical name — then `gh api -H
  "Accept: application/vnd.github.raw+json" repos/<o/n>/contents/TEMPLATE.md`
  and `…/readme`. `visibility` is lower case. When gh is missing, signed out
  or fails, `error` says why and the answer is still `200`, read from
  `local_folder` when there is one. `local_folder` is a repository directly
  in the default folder (`settings.default_folder`, else home; at most 2,000
  entries looked at) whose `origin` (else first remote), read from
  `.git/config` with nothing run, is `github.com/<o/n>`. For `folder`:
  `TEMPLATE.md` and `README.md` are read from disk (regular files only,
  256 KiB each), and `github` is set when its origin is on github.com.
  `template_md` is the `TEMPLATE.md` text, at most 64 KiB on a rune boundary,
  `""` when there is none or it is not UTF-8. `suggested_name` is
  `new-<repository or folder name>`, numbered (`-2`, `-3`, …) while that is
  taken in the default folder. Both or neither of `github` and `folder`,
  a malformed `github`, or a `folder` that is not an absolute folder is
  `400`.
- **Defaults** (`brief_path`, `prompt`), first match wins: (1) a marker
  comment at the very top of `TEMPLATE.md` (after blank lines and a BOM; CRLF
  read as LF):

  ```
  <!-- caprock-template
  brief: docs/source-spec.md
  prompt: Read TEMPLATE.md. Build the .ai/ corpus from {brief}.
  -->
  ```

  either key optional, a line naming no key continuing the prompt, a value
  that fails the checks above ignored; (2) for the brief, the first
  backticked `` `docs/<x>.md` `` in `TEMPLATE.md`, then in `README.md`
  (Corpus's README gives `docs/source-spec.md`); (3) `docs/brief.md`, and the
  prompt `Read TEMPLATE.md and follow it. The brief of this project is
  {brief}.` when there is a `TEMPLATE.md`, else `Read {brief}, the brief of
  this project, and the README, then start the work as they say.`
- **`CreateRequest`** — `{op_id, source: {github?, folder?}, via:
  "github"|"local", name, parent, visibility?, brief, brief_path,
  template_name?}`; the body is at most 2 MiB (`413` past it). `op_id` as
  for a clone (`[A-Za-z0-9_-]{1,64}`, generated when absent); one already
  known returns that operation with `existing: true` and starts nothing.
  `name` is `^[A-Za-z0-9._-]{1,100}$`, not `.` or `..`: the folder's name
  and, on GitHub, the repository's. `parent` is absolute (`~` is home) and
  made when missing, after every other check. `brief` is the brief's text:
  not blank, at most 1 MiB of UTF-8, no NUL. `400` for anything outside
  these bounds; `409` with `"<parent>/<name> already exists; add it instead,
  or pick another name"` (home written `~`) when that is a file, a link or a
  folder with anything in it — an empty folder is used, as for a clone — or
  when another operation is making it.
  - **`via: "github"`** needs `source.github` and the person's gh ready:
    otherwise `409` with `GHStatus.error`, and nothing is made — the daemon
    never takes the local path instead. `visibility` is `private` (default)
    or `public`. Steps: `create` — `gh repo create <login>/<name> --template
    <o/n> --private|--public` (no `--clone`); `clone` — `gh repo clone
    <login>/<name> <parent>/<name> -- --progress`, git's progress in `phase`
    and `progress`; GitHub fills a repository made from a template a moment
    after it exists, so when `git rev-parse --verify HEAD` fails after a
    clone, the folder is emptied (or removed, when Caprock made it), and the
    clone tried again after 2 s, six tries in all. Listed with `source:
    "clone"`.
  - **`via: "local"`** needs `source.folder`, an existing absolute folder
    that the new project is not inside (`400` otherwise); gh is never run.
    Step `copy`: when the folder is the top of a repository with a commit,
    its last commit (`git archive --format=tar HEAD`, unpacked by the
    daemon) — uncommitted changes are not copied; otherwise its files,
    leaving out `.git` and `node_modules` at any depth. No path leaves the
    project, nothing is written through a link, a link is kept only when it
    is relative and still resolves inside once every file is in place, and
    FIFOs, sockets and devices are skipped (counted in a note). At most 5,000
    files and 256 MB (ADR-050's limits); past either the operation fails,
    not retryable. Then `git init -q`, `git add -A` and `git commit -q
    --no-verify -m "Start from the <template_name> template"` ("Start from a
    template" without one). Listed with `source: "new"`.
  - **Then, either way:** `brief` — the brief written at
    `<dest>/<brief_path>`, each folder on the way made or a real folder (a
    link on the way must resolve inside the project, symlinks resolved), an
    existing plain file replaced, anything else there refused; `commit` —
    `git add -- <brief_path>` and `git commit -q --no-verify -m "Add the
    project brief" -- <brief_path>`, never pushed; `add` — listed as a
    project (`kind: "repo"`). Without a git identity (name and email) the
    commits are skipped, the files stay uncommitted, a note says how to set
    one, and the operation still ends `done`. The agent is not started here:
    the client starts it with `POST /v1/agents` (`cwd` the new project,
    `prompt` the template's with `{brief}` replaced) once the op is `done`.
  - **Environment** for gh and git: the login shell's
    (`internal/userenv`) plus `GH_PROMPT_DISABLED=1`,
    `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`,
    `LC_ALL=C`; every process through `internal/hidewin`.
  - **Failure** cleans up only what Caprock made on this machine: a folder
    it created is removed, a folder the person had made empty is emptied and
    kept (`removed: true` either way when something was there). A GitHub
    repository is **never** deleted; a note names it. `retryable` is true
    unless trying again would only repeat it: the name already taken on
    GitHub, the brief refused, the copy past its limits.
- **Retry** runs a failed, retryable template operation again under the
  same `op_id`, from its step — a repository already made on GitHub is
  cloned, not made again. `404` for an op not remembered (an hour after it
  ended, or across a restart), `409` when it is running, done, not
  retryable, its destination is no longer free, gh is not ready, or gh is
  now signed in as another user than the one who made the repository.
- **`Op`** for these is `kind: "template"` (§ Projects and shells), with
  `step: "create"|"clone"|"copy"|"brief"|"commit"|"add"`, `url` (the
  template: `https://github.com/<o/n>` or its folder), `dest`, `repo?`
  (`<login>/<name>`) and `repo_url?` once made, `notes?` (what the person
  should know, in order), `retryable?` and `removed?` on failure, and
  `project_id` when done. A daemon restart forgets a running operation
  ([12-risks.md](12-risks.md), `RISK-09`).

### Saved prompts and commands

Short text the user sends to an agent, and one-line shell commands, each with
a name, for every project or for one ([ADR-051](08-decisions.md)). Code:
`internal/api/saved.go`, `internal/store/saved.go`, `ui/src/lib/saved.ts`.

```
GET    /v1/saved-prompts[?session=<id>]    → {items: [SavedPrompt], max}; ?session keeps every project's and that session's project's
POST   /v1/saved-prompts                   {kind, name, text, project_id?, sort?} → {item: SavedPrompt}
PATCH  /v1/saved-prompts/{id}              {kind?, name?, text?, project_id?, sort?} → {item: SavedPrompt}
DELETE /v1/saved-prompts/{id}              → 204
```

- **`SavedPrompt`** — `{id, kind: "prompt"|"command", name, text,
  project_id?, project_root?, project_name?, sort, created_at, updated_at}`
  (unix ms). `project_id` absent (0 in a request) is every project;
  `project_root` and `project_name` are joined from `projects`, and stay
  while the project is unlisted. Listed every-project first, then by project
  name, `sort`, name.
- **Limits.** `name` trimmed, 1–80 characters, one line; `text` trimmed, no
  NUL, valid UTF-8; a prompt at most 8 KiB and any number of lines, a command
  at most 1 KiB and one line. At most 200 rows: the 201st `POST` is `409`.
  `project_id` must name a project (`400`). An unknown id is `404`.
- **`?session=<id>`** keeps the rows for every project and those whose
  `project_root` holds the session's `cwd` (segment boundaries; `404` for an
  unknown session): the phone's chips.
- **Who.** `GET` is open to every paired device; `POST`, `PATCH` and
  `DELETE` to none (`403`): they change what this machine types and runs.
- **Using one is not an endpoint.** A prompt is typed into a session Caprock
  started with `POST /v1/agents/{id}/input` — the text with each line break as
  ESC CR, then `\r` on its own 80 ms later, as the message field does; a
  command is `POST /v1/shells {cwd, type: <text>, run: true}`.

### Inbox

A note, a link or a photo saved for later — from the phone's **Save**, from
another app's **Share** on the phone, or on the machine — kept for the user to
start a chat from on the Mac ([ADR-056](08-decisions.md)). Code: `internal/api/inbox.go`,
`internal/store/inbox.go`; the files are written by `writeUpload` in
`internal/api/paste.go`, with the same checks as a pasted file.

```
GET    /v1/inbox                    → {items: [InboxItem], max}; newest first
POST   /v1/inbox                    {text?, project_id?, files?: [{name, type, data: base64}]} → {item: InboxItem}
DELETE /v1/inbox/{id}               → 204; its files are deleted with it
GET    /v1/inbox/{id}/files/{n}     → the n-th file's bytes, images only (thumbnails)
```

- **`InboxItem`** — `{id, text, files: [path], project_id?, project_root?,
  project_name?, from_device?, created_at}` (unix ms). `project_id` absent
  (0 in a request) is the Inbox itself; `project_root` and `project_name` are
  joined from `projects`. `files` are absolute paths under
  `<data_dir>/inbox/<UTC stamp>-<random hex>/<name>`, one directory per file,
  kept until the item is deleted (a pasted file goes after 30 days; these do
  not). `from_device` is the paired device's name, absent when saved on the
  machine.
- **Limits.** `text` trimmed, no NUL, valid UTF-8, at most 16 KiB; text or
  at least one file; at most 4 files, each checked as `POST /v1/paste`
  checks one (the extension allow-list, 10 MB, `415` for a refused type, the
  name sanitised). A refused file leaves nothing behind. At most 500 items:
  the 501st `POST` is `409`. `project_id` must name a project (`400`); an
  unknown id is `404`. `501` for a file when the daemon has no data
  directory.
- **Files are served as images only.** `GET …/files/{n}` answers png, jpg,
  jpeg, gif and webp with their type, `nosniff` and a day's private cache;
  any other file is `404` (an HTML or SVG file served from this origin would
  run as the dashboard; the session reads it by path instead), as is a path
  that is not directly inside one of the Inbox's own directories.
- **Who.** Both `GET`s are open to every paired device; `POST` and `DELETE`
  to a controller and the machine (a viewer gets `403`). Saving puts nothing
  into any session: a chat starts from an item only when the user starts
  one.
- **Live.** Each save and delete publishes an `inbox` frame, `{id,
  deleted}`, on `/v1/live`.

### Second Brain

What the sessions decided, found and left open, kept as a graph
([ADR-063](08-decisions.md)). Code: `internal/api/brain.go`,
`internal/store/brain.go`, `internal/store/brainsearch.go`; DDL in § Second
Brain DDL (migrations 0055, 0056).

```
GET    /v1/brain                ?q=&project=&since=&until=&limit=&summaries=1 → {nodes: [BrainNode], edges: [BrainEdge], total, terms?, close?}
GET    /v1/brain/status         → {memories, manual, projects: [{project, count}], auto?, db_path?}
GET    /v1/brain/handoff        ?project= → {project, decisions: [BrainNode], memories: [BrainNode], max, budget, decisions_max, decisions_budget, served?: {on, left_off_at?, holdout_pct}}
GET    /v1/brain/spend          ?days=1–90 (14) → {days: [{day, start, tokens, cost_usd, reads}], projects: [{project, reads, tokens, cost_usd, memories}], daily_tokens, spent_24h, claude_tokens_24h}
GET    /v1/brain/decisions      ?project=&limit= → {project, decisions: [BrainNode]}
POST   /v1/brain/nodes          {text?, title?, summary?, kind?, event_id?, session_id?, project?, topics?: [string], pinned?} → {node, created}
GET    /v1/brain/nodes/{id}     → {node: BrainNode, links: [{node, kind, out, weight}]}
PATCH  /v1/brain/nodes/{id}     {kind?, title?, summary?, pinned?} → {node}
DELETE /v1/brain/nodes/{id}     → 204
POST   /v1/brain/links          {from, to, kind?} → 204
DELETE /v1/brain/links          {from, to, kind?} → 204
PUT    /v1/brain/settings       {auto?, daily_tokens?, model?} → BrainAutoStatus
POST   /v1/brain/backfill       {days?: 1–90 (30), dry_run?} → BrainEstimate
```

- **`/v1/brain/handoff`** — what a new session in `project` (required,
  exact; else `400`) is handed from Second Brain with its handoff
  (§ SessionStart handoff), picked by the code the handoff itself runs
  (`store.BrainHandoff`): `decisions`, the current decisions, newest
  first, at most `decisions_max` (15), each line `- #id title` counted
  against `decisions_budget` (1,500 runes); then `memories`, with their
  summaries — pinned first, then newest, at most one per source session,
  none superseded and no decision already listed, at most `max` (5), each
  line `- kind: title — summary` (the summary clipped to 160 runes)
  counted against `budget` (700 runes). In each part the first line that
  does not fit ends it. `served` is whether a session opening there now
  would be handed the passage too: `on` is Memory between sessions,
  `left_off_at` when the passage it would be handed was written (unix ms;
  absent when none of 400 runes or more is within 14 days, and then the
  decisions and memories go alone), `holdout_pct` the share of new
  sessions held back at random (§ SessionStart handoff, *Measuring it*).
  `served` is absent from a daemon that does not wire it (tests). A read:
  it writes nothing, rolls no holdout and records nothing on a session.
- **`/v1/brain/spend`** — what the automatic extraction's reads spent,
  from `brain_runs` (code: `internal/api/brainspend.go`,
  `internal/store/brainspend.go`). `days` is one entry per local day of
  the daemon's time zone, oldest first, today the last, every day present:
  `day` its date (`YYYY-MM-DD`), `start` its midnight (unix ms; a day with
  a clock change is 23 or 25 hours), `tokens` the reads' `tokens_in +
  tokens_out` by when each finished, `cost_usd` their summed `cost_usd`
  (what claude reported, at API list price), `reads` the runs that asked
  claude (status `ok` or `failed`; a `skipped` session is no read, and
  costs nothing). `projects` is the same window by the read session's
  project (`brain_runs` joined to `sessions`; `""` when the session has no
  project or is gone), most tokens first: `reads`, `tokens`, `cost_usd`,
  and `memories` — the `nodes` of the reads with status `ok`; a project
  with nothing but skipped sessions is left out. The re-tag batches
  (*Re-tag* below) are one row of their own, `{project: "", retag: true,
  …}`, `memories` the memories they gave keywords, never folded into the
  `""` of reads without a project; they count in `days` like a read, and
  are left out of the mean a catch-up's `days_left` is counted from. `daily_tokens` is the
  daily limit (0 in a build without the extraction). `spent_24h` is the
  reads' tokens in the last 24 hours (the status's `spent`) and
  `claude_tokens_24h` the input, output, cache-read and cache-write tokens
  of Claude Code's assistant turns in the recorded sessions in the same 24
  hours (agent `claude`, `internal = 0`; a fork's copy of a turn carries
  none). The reads are not sessions — no transcript, no hooks — so they are
  not in it: the share of all Claude tokens is `spent_24h / (spent_24h +
  claude_tokens_24h)`. `days` outside 1–90 or not a number is `400`. A
  read: it writes nothing.
- **Current decisions** (`/v1/brain/decisions`, migration 0069). A
  decision is current until a newer memory has a `supersedes` edge to it.
  The route returns `project`'s (required, exact; else `400`) current
  decisions, newest first, at most `limit` (default 50, at most 100);
  `agents=1` leaves out what may not reach an agent, as the graph read
  does. The automatic extraction is shown the same registry (*A read*,
  below) and may answer that a new decision supersedes one; a person can
  too, with `POST /v1/brain/links {from: newer, to: older, kind:
  "supersedes"}` — both must be memories of the same project and `to` a
  decision, else `400`. **Undo** is `DELETE /v1/brain/links {from, to,
  kind: "supersedes"}`: with a `kind`, the delete removes that one edge
  from `from` to `to` and leaves any other link between them; without
  one, every edge between the two in either direction, as before. A
  search ranks a superseded memory after every current one, and the
  graph read and a node's own read name its replacement
  (`superseded_by`).
- **`db_path`** on `/v1/brain/status` — the database the memories live in, `caprock.db` in the daemon's data directory (`config.DBPath`), resolved by the daemon rather than guessed per OS by the page; the screen's *Where it's kept* shows it. Omitted when the daemon has no data directory (tests).
- **`BrainNode`** — `{id, kind, title, summary, source: {session_id?,
  event_id?, ts?, project?}, manual, pinned, run_id?, created_at, updated_at,
  degree?, rank?, close?, vault?, keywords?, superseded_by?}`; times are unix ms. `kind` is `idea`, `decision`, `finding` or
  `question` (a memory), `note` (an Obsidian import; § Obsidian vaults), or
  `topic`, `person` or `project` (an entity).
  `title` is at most 80 runes and `summary` 400, clipped with `…` on the way
  in. `manual` is true for a node dropped in by hand; `run_id` names the
  automatic extraction's read that made it. `degree` is the number of
  returned edges touching the node, in a graph read only; `rank` and
  `close` are a search's (below). `keywords` are the five to eight English
  search keywords the extraction gave a memory, whatever language its title
  is in (migration 0069; trimmed, a comma made a space, deduplicated
  folded, at most 8 of at most 40 runes); none on an imported note, nor
  on a memory made before them or by hand until the extraction's re-tag
  gives it some (*Re-tag* below). `superseded_by`
  is the newest memory with a `supersedes` edge to this one, in the graph
  read and a node's own read; absent while it is current.
- **`BrainEdge`** — `{from, to, kind, weight}`; `kind` is `relates`,
  `follows`, `contradicts`, `part_of` or `supersedes` (from a newer
  decision to the older one it replaces; migration 0069). One edge per `(from, to, kind)`;
  linking an existing pair again adds its weight, capped at 10. A memory
  hangs off its project and topics with `part_of`.
- **The graph read** returns the newest memories and imported notes that pass the filter
  (pinned first, then by `created_at`), at most `limit` (default and ceiling
  5,000), the entities their edges reach, and every edge between returned
  nodes; with no filter and no `limit`, every entity too, linked or not.
  `project` is exact; `since` and `until` bound `created_at`. Only entities join a selection through its
  edges; a memory a selected one relates to is not returned unless it
  passes the filter itself. `total` counts the memories that pass the
  filter, whatever the limit. Summaries are `""` unless `summaries=1`; a
  node's own read carries its summary.
- **Search (`q`).** The query is folded — NFKD, the combining diacritics
  of U+0300–U+036F dropped, Unicode lower case, `ς` as `σ`
  (`store.FoldSearch`) — and split into words at anything that is not a
  letter, digit or mark, in every script. Common English function words
  (`a`, `the`, `of`, `per`, `no`, `as`, …; `store.brainStopwords`) are
  dropped unless the query is nothing else. A word, or two neighbouring
  words, in a synonym set make one **term** that looks for every member:
  `pr` = `prs` = `pull request` = `pull requests`; `cost` = `costs` =
  `price` = `prices` = `pricing` = `spend` = `spending`; `decision` =
  `decisions` = `rule` = `rules`. A whitespace-separated piece that is
  several words joined by punctuation (`read-only`, `project-3`) is also a
  term of its own, first, so a memory with the whole of it ranks above one
  with a part (at most 4 such). At most 8 terms. A term matches a
  **whole word** of a memory's folded title, keywords, summary or project
  — `pr` is not in *project* or *prompt* — or, for a term of 4 runes or
  more, the start of a word (`router` finds *routers*); in a script
  written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer,
  Myanmar) any substring counts, so `タワー` finds *東京タワー*. A term in
  the name of a topic, person or project the memory has an edge to counts
  too. **Any term** matching is a hit (`ΑΘΗΝΑ` finds *Αθήνα*, `CAFE`
  finds *café*). Each term weighs 3 for a whole word of the title or the
  keywords, 2 for the start of one there, 1 for a whole word of the
  summary or project, 0.7 for the start of one there, 0.8 for a linked
  entity's name — a synonym 0.9 of that — times its **IDF** over the
  memories searched, ln(1 + N/df), so a word few memories have outweighs
  one most have; `rank` is the sum over the terms times 100, rounded.
  When fewer than 5 memories match that way, a term of one word of 4–7
  letters may also match a word 1 edit away, and one of 8 or more 2 edits
  (insert, delete, change, or swap two neighbours), or the start of a
  longer word that close — a typo or a different ending — weighing 0.6 in
  the title or keywords and 0.3 elsewhere, both in memories no term
  matched and for the terms a hit did not match; such a memory is a close
  match (`close: true`). Words with anything but letters and digits, and
  shorter ones, match exactly only. The close pass reads at most 20,000 of
  the newest matching-filter memories and compares at most 50,000
  distinct words. A search returns memories best first — current before
  superseded (*Current decisions*, above), then rank, then pinned, then
  newest — so `limit` keeps the best. `terms` are the folded terms with
  their synonyms and the close words that matched (at most 32), for the
  screen to mark; `close` is true when a returned memory is a close match.
  Both, and `rank`, are absent without `q`. Measured with
  `BenchmarkBrainSearch` (2026-10-15, Apple M1 Pro, a 400-character
  summary per memory, the graph read included, before whole words and
  IDF): 1,000 memories 2–4 ms, 5,000 memories 10–14 ms for a word and
  19–34 ms when the close pass runs, against 6 ms and 56 ms for the same
  read with no search. On a copy of the owner's database (1,221 memories,
  2026-10-22) each of five queries took 4–7 ms; `PR` went from 1,097
  memories to 136.
- **A drop.** `kind` defaults to `idea`. With `event_id` the daemon reads
  the note's text, session, time and project from `events` itself — the event
  must be main-thread assistant prose (§ Phase 0's notes rules), else `400`.
  The same answer dropped again returns the memory already made from it
  (`created: false`). With `session_id` alone the source is that session at the current time.
  Without a `title`, the first line of `text` (or the note) that says
  something, its Markdown stripped, is the title and the passage, flattened,
  the summary — none when one short line is the whole of it. An entity whose
  normalised title exists (lower case, spaces collapsed, punctuation at the
  ends dropped) is returned with `created: false` rather than added again.
  The memory is linked `part_of` its project (an entity made on demand) and
  each topic (at most 8). `text` at most 64 KiB, valid UTF-8, no NUL.
- **Free, no cap** (owner decision, 2026-10-14). No route here answers
  `402` or looks at the licence: a memory is kept however many there are,
  and the automatic extraction runs for anyone who turned it on. The status
  carries no `licensed`, `free_max` or `free_left` (dropped with the cap).
- **Errors.** `404` for an unknown node; `409` when a rename would give an
  entity the normalised title of another of its kind; `400` for an unknown
  kind, an empty title, a self-link. `503` with `Retry-After: 1` and `{error,
  detail}` when another writer held the database past busy_timeout: nothing
  was saved, and the same request lands a moment later (the dashboard tries
  a drop three more times, a second apart). Every route answers a busy
  database that way rather than with a bare `500`.
- **Who.** The five `GET`s are open to every paired device; every write,
  settings and backfill included, is the machine's (a device gets `403`).
- **Live.** Every change publishes a `brain` frame on `/v1/live`: `{id, op:
  "added" | "changed" | "deleted", kind?, title?, auto?, session?, project?,
  run?, agent?}` (`kind` and `title` absent on a delete; `session` and
  `project` only on `added`, each when the memory's source has it, so a
  screen can show the memory arriving from that session's tab; `run` — the
  `brain_runs` id — and `agent` — the session's agent — only on a memory an
  automatic read kept). The automatic extraction also publishes `{op:
  "progress", phase: "start", session, project, agent}` (no id) as a read
  begins, and `{op: "progress", phase: "done", run?, session, project,
  agent, added}` as it ends — after the read's `added` frames, `added`
  their count (0 when it kept nothing or failed; `run` absent when no run
  was recorded) — so a screen showing the build reads the status again and
  the sidebar shows one arrival per read; a screen showing memories ignores
  both. When a new session's handoff carries Second Brain memories
  (`sessions.handoff_brain` set above 0, § SessionStart handoff), the
  daemon publishes `{op: "handoff", session, project, memories}`; a session
  held back by the holdout, or handed none, gets no frame.
- **The automatic extraction** (`internal/brain`, free). `auto` in the
  status is `BrainAutoStatus` — `{chosen, on, enabled, claude_found, model,
  daily_tokens, spent, spent_usd, stage, last_read?, new_today, topics,
  links, handoff, running, pending, since?, backfill_since?, last_wake?,
  next_wake?, last_error?, recent: [BrainRun], reading?, build?,
  catch_up, retag?, agents_24h}`: `chosen` once
  the user has answered, `enabled` when on (only then does it read; no
  licence is looked at), `last_wake` and `next_wake` unix ms — `next_wake`
  absent while off, at or before now just after turning on or while a wake
  runs, so a screen can say when the first memories may come — `spent`
  the tokens of the reads and re-tag batches (*Re-tag* below) in the last
  24 hours, `pending` the sessions waiting (counted up to 200), `recent`
  the last reads of sessions that were not skipped (no re-tag batch).
  `spent_usd` is the `cost_usd` of the same reads and batches in the last
  24 hours — what claude reported, at API list price; `last_read` when the
  newest read of a session with status `ok` finished; `new_today` the memories (not entities) added
  since the daemon's local midnight, by hand or read; `topics` the topic
  entities and `links` the rows of `brain_edges` that join one memory to
  another (a link to a topic, person or project is not counted). `stage` is where the
  build is: `off` (not on), `extracting` or `linking` (a read is asking
  claude, or storing what it returned), `no_claude`, `limit` (sessions
  wait and `spent` has reached `daily_tokens`), `waiting` (sessions wait
  for the next wake), `up_to_date` (none waits) — in that order of
  precedence. `handoff` is how memories reach agents: `{on, sessions_24h,
  memories_24h, sessions, memories}` — `on` whether Memory between sessions
  is on (without it no session is handed anything), then the sessions
  started in the last 24 hours, and in all, that were handed Second Brain
  memories with their handoff and how many (`sessions.handoff_brain`,
  § SessionStart handoff). `agents_24h` is `[{agent, sessions, last_at}]`:
  the agents whose sessions a read with status `ok` went through in the
  last 24 hours (`brain_runs` joined to `sessions`, re-tag batches left
  out; no agent recorded counts as `claude`), `sessions` the distinct sessions, `last_at` when the newest
  of those reads finished (unix ms), most sessions first; `[]` when none.
  `BrainRun` is `{id, session_id, from_event_id,
  through_event_id, status: ok | failed | skipped, model?, tokens_in,
  tokens_out, cost_usd, nodes, error?, started_at, finished_at, project?,
  title?, agent?, gap_id?}`; `title` is the session's own name, else its first
  stored prompt, and `agent` its agent, joined in; `gap_id` the catch-up
  gap a read went through, absent on a regular read.
- **What it reads now, and how far it is.** `reading` is present while a
  read is asking `claude` about a session: `{session_id, title?, agent?,
  project?, last_event_at?, started_at, phase, passages}` — `phase`
  `extracting` while claude is asked, `linking` while its memories are
  stored and linked (no frame of its own; it lasts milliseconds),
  `passages` how many passages of prose were sent; `title` the session's own name,
  else its first prompt, flattened and clipped to 80 runes; `last_event_at`
  when the session last did something and `started_at` when this read
  began (unix ms). `build` is present while it is on: `{from, sessions,
  read, memories, truncated?, sources: [{project, read, pending,
  memories}]}` — `from` the start of what is in reach (the earlier of
  `since` and `backfill_since`); `read` the sessions active since `from`
  that a read has gone through without failing and that have nothing new
  since; `sessions` that plus the sessions waiting (`pending`), so a
  session read before and waiting again counts once, as waiting; a live
  session joins once it has been quiet ten minutes, and one waiting out a
  failure is in neither; `memories` what the reads of those sessions kept
  (as recorded per read); `truncated` when the waiting were counted only
  to 200; `sources` the same per project, most sessions first, at most 12.
- **Catching up.** `catch_up` is `{kind, done, total, truncated?,
  days_left?}` while it is on and a catch-up has reads left, else `null`.
  One shape for every kind, so a screen reads it the same way whatever is
  being caught up on; with both left, `skipped` (*Catch-up* below) is the
  one shown, `backfill` once it is done. `kind`
  `backfill` is the sessions a backfill brought into reach: those in reach
  whose last event is before `since` (when it was turned on) — present
  only while `backfill_since` is before `since` and one of them waits.
  `done` is those read with nothing new since, `total` that plus the ones
  waiting (`truncated` when the waiting were counted only to 200).
  `days_left` is an estimate, said as one: the reads left times the mean
  tokens of the reads that spent any in the last 14 days, over
  `daily_tokens`, rounded up; absent before any read was measured.
- **Settings.** `auto: true` starts reading from that moment and wakes the
  reader at once, not at the next five-minute wake — on the daemon's own
  loop, never under the request; a wake that read a full four is followed
  by the next after three seconds rather than five minutes, so a build
  reads one session after another within the daily limit; a second `true` while on does not wake it
  again, and a wake never runs beside another; `false` stops it. Neither needs a licence. `daily_tokens`
  is 20,000–5,000,000 (the screen offers 100k, 300k and 1M; the default is
  300,000) and `model` is `""`, `haiku` (the default) or `sonnet`; anything
  else is `400`. Kept in `config.json` as `brain: {auto?, since?,
  backfill_since?, daily_tokens?, model?}`; `auto` absent means the user has
  not answered, and nothing runs.
- **Backfill.** `BrainEstimate` is `{sessions, tokens_estimate,
  days_estimate, daily_tokens, truncated?}`: the sessions since `days` ago
  with unread prose worth a read, and an estimate of their tokens (a
  quarter of the characters sent, plus the call's measured fixed cost,
  4,300, plus 400 for the answer, for every read a session takes — a long
  one is read in chunks), labelled an estimate on screen. Without
  `dry_run` it also sets `backfill_since`, which needs the extraction on
  (`409`), and wakes the reader.
- **A read.** A session is a candidate when its last event is after
  `since` (or `backfill_since`), it has ended or been quiet ten minutes, and
  it has main-thread prompts or answers after the last read that did not
  fail. Its passages are numbered and sent, with the project, up to 60
  existing topic titles and — for a session with a project — that
  project's 30 newest current decisions (`#id title`) and its 40 newest
  memories besides them (`#id kind: title`, *do not repeat these*), on
  stdin to the user's `claude` (flags in ADR-063). A "user" turn that starts with a machine tag — one of a
  known list (`task-notification`, `system-reminder`, `command-name`,
  `cross-session-message`, …) or any kebab-case tag — is left out; a
  prompt is clipped at 2,000 characters, an answer at 2,500. One read
  sends at most 24,000 characters and 400 passages,
  the oldest unread first; a session with more is read in chunks, each
  read's `through_event_id` the last passage it sent (the session's newest
  event when it sent the rest), so nothing is skipped and the next read
  goes on from there. A wake makes at most four calls, whether to four
  sessions or four chunks of one, a session's chunks back to back; the
  rest waits for the next wake. The answer is `{memories: [{kind, title, summary, topics?,
  keywords, passage?, related?, contradicts?, supersedes?, related_ids?,
  contradicts_ids?}]}`, at most eight kept: each a node with
  `run_id`, `manual: false`, its `keywords` (English, whatever the
  title's language; the title and summary stay in the session's) and the
  cited passage's event as its source,
  `part_of` the project and its topics, `relates`/`contradicts` to the
  others named by index, and to the shown memories named by id
  (`related_ids`, `contradicts_ids`); a decision's `supersedes` ids become
  `supersedes` edges from it to those shown current decisions. An id the
  read was not shown is ignored. A memory whose title is near one the
  project already keeps — among its 300 newest — or one kept earlier in
  the same answer is left out: their folded words overlap by 0.75 or more
  (Jaccard, shared over all, at least two words each; a one-word title
  only when the same; `store.BrainTitlesNear`). Fewer than 300 runes of agent prose and fewer than 200 of the user's
  typed prompts (machine-tagged turns do not count) in a read: recorded
  `skipped`,
  never sent — except at the end of a session that has not ended: there
  the read is recorded `skipped` with `held` set and the cursor stays, so
  that prose is read with whatever the session says next, and the session
  is not a candidate again until it has newer events or ends; once it has
  ended, a short tail is marked read. A failure is recorded with its error and retried after 15
  minutes, doubling; after four the session waits for new prose. The
  project is the session's own, except for a session whose `cwd` is under
  the system's temp directory (`os.TempDir`, `/tmp`, `/var/folders` and
  their `/private` forms), where that label is a throwaway folder's name:
  there it is the repository's name from its remote's web address when the
  session's `repo_root` is a checkout with one, else none, so the memories
  hang off their topics only and the read is sent without a project.
- **Catch-up.** Until 2026-10-22 a read kept only the newest 24,000
  characters of a session's unread prose and moved the cursor past the
  rest. Migration 0068 lists every read with status `ok` made before it in
  `brain_gaps`; on its first wake the reader measures each by re-running
  that old cut against the stored events (the newest 400 main-thread turns
  up to the read's `through_event_id`, prompts clipped at 600 characters,
  newest first until 24,000) and keeps the span it never sent, after
  `from_event_id` up to the event before the oldest passage it did send,
  with the reads that span takes now; a read that skipped nothing loses
  its row. A gap is read with the same chunks, prompt and model as a
  regular read, oldest first, its `cursor` saved with each read so a
  restart goes on from there, its memories carrying the session's project
  by the same rule, and its prompt opened with one line saying it is an
  earlier part of a session already read. It is shown the project's recent
  memories, as a regular read is, but not its current decisions: the prose
  is older than they are, so nothing it says may supersede one. It is read only while the
  extraction is on, only when no session waits, with what is left of a
  wake's four calls, and within the same daily limit; a chunk with too
  little to say is marked read; failures are retried as a session's are
  and the gap given up after four in a row. The reads are `brain_runs`
  rows with `gap_id` set, which never move a session's cursor. `catch_up`
  in the status is `{kind, done, total, truncated?, days_left?}` while it
  is on and a gap is left to read, else `null`. For this catch-up `kind`
  is `skipped` (the screen also knows `backfill`), `done` and `total` the
  reads made and in all over every gap found, `truncated` never set, and
  `days_left`, present only when reads are left to estimate, an estimate,
  labelled as one on screen, of the days the rest takes — the reads left
  times the mean tokens of the catch-up reads so far (before the first, a
  full read's: 6,000 + 4,300 + 400), over `daily_tokens`, as if the
  catch-up had the whole limit.
- **Re-tag.** A memory with no `keywords` — kept before migration 0069, or
  typed by hand — is given them in batches, so an English query finds one
  titled in another language. A memory here is `idea`, `decision`,
  `finding` or `question`; an imported note and an entity never are. Only
  while the extraction is on, and only in a wake that finds no session
  waiting (a session waiting out a failure does not count): what the
  catch-up (*Catch-up* above) leaves of the wake's four calls goes to the
  re-tag then, and a session that comes to wait goes first at the next
  wake. Each call sends 40 memories, lowest id first,
  above the re-tag's cursor, one per line as `#id kind: title — summary`
  (the summary clipped to 200 runes), to the same `claude`, flags and
  model as a read, with its own instructions and `--json-schema`; the
  answer is `{tags: [{id, keywords}]}`. Only an id the batch sent is kept,
  the first answer for an id wins, the keywords are cleaned as a read's
  are (five to eight, at most 40 runes each), and a memory that has
  keywords by then is left alone; `updated_at` does not move. Each batch
  is a `brain_runs` row with `session_id` `caprock:retag`,
  `from_event_id` and `through_event_id` the first and last memory id it
  sent, `nodes` the memories it gave keywords, and its tokens and cost as
  claude reported them — so it counts toward `daily_tokens`, `spent` and
  `spent_usd` like a read, and no migration is needed. The cursor is the
  highest `through_event_id` of a batch that did not fail, so the re-tag
  resumes there after a restart and a memory the answer left out is not
  asked again. A failed batch is retried after 15 minutes, doubling;
  after four it is recorded `skipped` (*gave up after repeated failures*)
  and the re-tag goes on past it. `retag` in the status is `{done, total}`
  while the extraction is on and memories without keywords wait above the
  cursor: `done` the memories batches gave keywords, `total` that plus
  those waiting; absent otherwise. It is its own field, not a kind of
  any catch-up progress, and it adds no frame: a screen reads the status
  while the extraction runs.
- **Privacy filter** (`internal/redact`, `internal/store/brainredact.go`).
  A memory is handed on — the handoff, other projects' screens, `caprock
  mcp` — so a credential or payment detail in one would spread. Every
  write of a node's `title`, `summary` and `keywords` runs through
  `redact.Text` before it is clipped: `InsertBrainNode` (the extraction,
  `POST /v1/brain/nodes`, entities), `UpdateBrainNode` (`PATCH`) and the
  re-tag's `SetBrainKeywords`; an Obsidian note's `excerpt` is redacted
  when it is parsed, so an unchanged file still compares equal. A value
  becomes `[redacted: <kind>]`, kind one of `private key` (a PEM block,
  or what a clip left of one), `api key` (`sk-…` with a vendor prefix or
  digits, Stripe `sk|rk|pk_live|test_…`, `AKIA…`/`ASIA…` but not a docs
  key ending `EXAMPLE`, `AIza…`), `token` (`ghp_…` and the other GitHub
  prefixes, `github_pat_…`, `xox?-…`, Telegram bot tokens, JWTs, a
  `Bearer` value), `card number` (13–19 digits, one kind of separator, a
  network's prefix and length, Luhn), `iban` (a known country's length and
  mod 97), `password` (after a password label — English, or Russian
  written as escapes — a value of six or more with a digit or a symbol,
  never a placeholder, variable, path, URL, identifier or plain word),
  `secret` (after a key, token or secret label, 16 or more characters with
  letters and digits, never a dotted name, an environment variable's name
  or joined words) and `bank account` (6–34 digits after an account,
  routing, ABA, sort code or BSB label, or the Russian ones). A keyword
  that held a value is dropped. Ordinary numbers, commit SHAs, UUIDs,
  versions, dates and prices are left alone. The prose a read sends is
  filtered the same way (`BuildInputKnown`), and the extraction's
  instructions forbid recording credentials, card or bank details, home
  addresses and ID numbers. The memories and note excerpts kept before
  the filter are scrubbed once on the daemon's start, in one transaction,
  whether or not the extraction is on (`brain.Engine.ScrubOnce`,
  `meta.brain_secrets_scrubbed`): changed nodes get their search document
  rebuilt, a note node is re-synced from its rows, an entity whose new
  title would collide keeps its title, and the log line holds counts by
  kind, never a value. On a copy of the owner's database (2026-10-22) it
  changed none of 1,468 nodes; over the 210,504 typed prompts and answers
  stored there, the filter matched 21 values, all of them credentials
  (API keys, bot tokens, a JWT, bearer headers, labelled passwords and
  keys), and nothing else.

### Obsidian vaults

Local Markdown imports in Second Brain ([ADR-079](08-decisions.md),
[docs/obsidian.md](../docs/obsidian.md)). These management routes are
machine-only; paired devices get `403`, including controllers:

- `GET /v1/brain/vaults` → `{vaults: BrainVault[]}`.
- `POST /v1/brain/vaults` accepts `{path, agents?: bool}` and synchronously
  imports a folder. `201` → `{vault, result}`; `agents` defaults false.
- `PATCH /v1/brain/vaults/{id}` accepts `{agents: bool}` → `{vault}`.
- `POST /v1/brain/vaults/{id}/refresh` rereads all Markdown files and resolves
  links again → `{vault, result}`.
- `DELETE /v1/brain/vaults/{id}` removes the import → `{removed: true}`.
  No source file is changed or deleted.

`BrainVault` is `{id, name, path, agents, notes, scanned_at?, scan_ms, error?,
created_at}`. Times are unix ms; `scan_ms` is elapsed scan time. `Result` has
`notes, read, added, changed, removed, merged, links, linked, unlinked,
skipped, ms, write_ms`, all counts except elapsed `ms` and `write_ms`. The
latter includes acquiring, running and committing the write transaction. Bodies are limited to 8 KiB;
unknown fields are rejected. `400` for invalid JSON, a missing `agents` field
on PATCH, a relative/non-folder path or more than 50,000 notes; `404` for an
unknown id; `409` for an already-imported path; `503` without the importer.
A failed first scan keeps the vault row and its error for Refresh/Remove.

Each Markdown filename supplies a title. Simple frontmatter aliases and tags,
inline tags and wikilinks are parsed without a model. A matching title/alias
adds a source to an existing memory or note; otherwise kind `note` is created.
The oldest source supplies a note node's summary; original session memories
retain their own summaries. Source aliases and excerpts participate in local
search. A matching project folder groups notes; otherwise project is Obsidian.
Only the first 4 MiB per file is read, excerpts at most 400 runes. Dot folders,
`node_modules`, attachments and symbolic links are excluded; rooted file reads
refuse a link escaping the vault even if a file changed after discovery.
A failed walk preserves previous sources; unreadable files keep their old row.

Saved vaults are checked two minutes after daemon startup, then ten minutes
after the previous pass. Automatic refresh reads changed size/mtime only;
manual refresh rereads everything. Files are read before the write transaction.
A `brain` frame `{op: "vault", vault: id}` follows changes and consent updates;
removal sends `{op: "vault_removed", vault: id}` so an open imported-note
card closes without rereading a deleted node.

Existing reads gain:

- `BrainNode.kind = "note"` and optional `vault`, the oldest source's vault
  name, in graph reads and node detail. `GET /v1/brain/nodes/{id}` additionally
  returns `sources: [{vault_id, vault, path, title, aliases?, excerpt, mtime}]`,
  with vault-relative paths. Imported notes are edited in Obsidian; title,
  summary and kind patches and individual deletes are `400`; pins are allowed.
- `GET /v1/brain/status` gains `notes`, separate from session `memories`.
  Graph `total` and project counts include notes.
- `agents=1` on graph, node and status reads applies per-vault consent.
  MCP always sets it. A node with any non-sharing source is excluded in full
  from MCP, including mixed-source memories, search and neighbour lists;
  imported entities from a non-sharing vault are excluded too. Agent node
  detail omits source rows. Project lists use the same filter.
- Handoff includes a note only if every contributing vault allows agents.
  Existing session memories still supply only their original summaries.
  Extraction excludes topics created by a non-sharing vault. Enabling sharing
  does not initiate a model call; disabling it affects future reads only.

The schema and ownership rules are below (§ Obsidian vaults DDL). Removing an
import preserves other sources and independent edges, including a manual or
extracted link added after the import first claimed it.

### MCP server

`caprock mcp` ([ADR-078](08-decisions.md)) is a Model Context Protocol
server for the user's own agents: JSON-RPC 2.0 on stdin/stdout, one message
per line, `\n` on every OS (a trailing `\r` on input is ignored). It opens no
listener. Stdout carries the protocol and nothing else. Code:
`internal/mcp` (`server.go` the protocol, `client.go` the daemon reads,
`tools.go` the tools, `redact.go`), `cmd/caprock/mcp.go`.

- **Methods.** `initialize` (answers the client's `protocolVersion` when it
  is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, else the
  first; `capabilities: {tools: {listChanged: false}}`, `serverInfo`
  `{name: "caprock", title, version}`, `instructions`), `ping`,
  `tools/list`, `tools/call`; `resources/list` and `prompts/list` answer
  empty lists. A notification (no `id`) is never answered; an unknown
  method is `-32601`, an unknown tool `-32602`, a line that is not JSON
  `-32700` with `id: null`, a line over 4 MiB a parse error, and the session
  goes on after each.
- **The daemon.** Found on every call from `<data_dir>/runtime.json`
  (`$CAPROCK_DATA_DIR` honoured) as `http://127.0.0.1:<port>`; only `GET`
  is ever sent. No daemon, or none answering: the tool's result is
  `isError: true` with *caprock is not running on this computer: start it
  with `caprock up`, or open the Caprock app, then ask again*.
- **Results.** One `text` content block of compact JSON, rebuilt from named
  fields only (never `transcript_path`, `spawn_command`, `pid` or a token),
  times as RFC 3339 in local time, money rounded to cents. Lists default to
  10 and stop at 50; memory summaries are clipped to 600 runes (1,500 in
  `get_memory`), prose to 1,500. The whole text is capped at 48 KiB on a rune
  boundary, with `[cut at N bytes: ask for fewer items]` appended when cut.
  Credentials and payment details are replaced with `[redacted: <kind>]`
  by Second Brain's privacy filter (§ Second Brain, *Privacy filter*:
  `sk-…`, `ghp_…`/`github_pat_…`, `xox?-…`, `AKIA…`/`ASIA…`, `AIza…`,
  Telegram bot tokens, Stripe `sk_/rk_/pk_live|test_…`, JWTs, `Bearer …`,
  PEM private keys, card numbers, IBANs, labelled passwords, secrets and
  bank accounts). A
  tool's failure — the daemon's 4xx message, a bad argument — is a result
  with `isError: true`, never a protocol error.
- **Repository.** `repo` is a directory inside it; absent, the directory
  the server was started in. It resolves as sessions group
  (`store.RepoFromCwd`): the root keys `/v1/sessions?dir=`, the name keys
  Second Brain's `project` and the daily totals. Outside a repository the
  directory stands for itself.

Every tool is annotated `readOnlyHint: true, destructiveHint: false,
idempotentHint: true`; `openWorldHint` is true for `ci_status` alone.

- **`search_memories`** `{query?, project?, limit? (30, at most 50)}` → `GET /v1/brain?summaries=1&q&project&limit`
  → `{total, returned, memories: [{id, kind, title, summary, project,
  session_id, pinned, created_at, topics[], keywords[], superseded_by?}],
  hint?}`: ranked candidates for the calling agent to judge by meaning,
  each summary clipped to 200 runes; entities are left out, a memory's
  `topics` are the topic entities linked to it; a superseded memory comes
  last and names its replacement. `hint` asks the agent to rephrase and
  search again when a query matched nothing; the tool's description says
  the same, and that titles are often in the user's language while
  keywords are English.
- **`current_decisions`** `{project?, limit? (50, at most 100)}` →
  `GET /v1/brain/decisions?project=&limit=` → `{project, decisions: [{id,
  kind, title, summary, project, created_at, keywords[]}]}`; `project`
  defaults to the repository the server was started in.
- **`get_memory`** `{id}` → `GET /v1/brain/nodes/{id}` → `{memory, links:
  [{relation, id, kind, title}]}`, at most 30 links; `relation` is the edge
  kind, `(from)` when the edge points at this memory.
- **`memory_topics`** `{project?}` → `GET /v1/brain` and `/v1/brain/status`
  → `{memories, topics: [{title, memories}], projects: [{project, count}]}`,
  topics by linked memories, at most 60 of each. With `project`, `memories`
  is that project's count and `projects` holds that project alone (empty
  when it has none), not the totals for every project.
- **`next_session_handoff`** `{repo?}` → `GET /v1/brain/handoff?project=`
  → `{project, current_decisions[], memories[], max_memories, handoff_on,
  left_off_at, holdout_pct, note}`.
- **`recent_sessions`** `{repo?, all_repos?, limit?}` →
  `GET /v1/sessions?dir=<root>&limit=` (or `?chats=exclude&limit=` with
  `all_repos`) → `{repo, project, sessions: [{id, agent, title,
  description, status, project, cwd, branch, model, started_at,
  last_event_at, doing, cost_usd, tokens, turns, tool_calls, files_touched,
  loop?}]}`; `title` is the user's name for the session, else the agent's.
- **`session_summary`** `{session_id}` → `GET /v1/sessions/{id}` →
  `{session, files[] (the 40 most recently touched), files_not_shown and
  files_note (*The 40 most recently touched files; +N more.*) when the
  session touched more, pull_requests: [{number, title, url}]}`.
  `files_not_shown` counts from the session's `files_touched`, not from the
  daemon's list, which stops at 100. An id holding `/`, `\`, `?` or `#` is refused
  before any request.
- **`session_prose`** `{session_id, limit? (5, at most 20)}` →
  `GET /v1/sessions/{id}/notes` → `{session_id, notes: [{session_id,
  project, at, text, fragment?}]}`, newest first.
- **`search_prose`** `{query, limit?}` → `GET /v1/notes?q=&limit=` →
  `{notes[]}` as above; an empty query is refused.
- **`cost`** `{repo?, all_repos?, days? (7, at most 90)}` →
  `GET /v1/stats/daily?days=` → `{days, project?, total: {cost_usd,
  tokens}, by_day[], by_model[] (at most 20, by cost), by_project[] (with
  all_repos, at most 30), note}`; a session count is not summed across
  models (a session on two models would count twice).
- **`ci_status`** `{repo?}` → the repository's newest session
  (`/v1/sessions?dir=&limit=1`), then `GET /v1/sessions/{id}/ci/main` and
  `/ci` → `{project, repo, github_connected, default_branch: {branch,
  state, commit, runs: [{workflow, status, conclusion, branch, commit,
  event, updated_at, url, failed_jobs: [{name, conclusion, failed_step,
  url}]}], error?}, pull_request?: {number, title, url, state, session_id,
  checks?, error?}}`, at most 12 runs and 8 failed jobs each. GitHub is read
  only while it is connected in Caprock, through the kept reads the CI panel
  makes; not connected, `github_connected: false` and a note. No session in
  the repository, no remote, or a remote off github.com: an error that says
  which.
- **`loop_alerts`** `{}` → `GET /v1/sessions?active=true&limit=500` →
  `{alerts: [{session_id, title, project, cwd, loop: {tool, count,
  window_min, sample, since, last, reread_tax_usd}}], running_sessions,
  note?}`; `reread_tax_usd` is the loop alert's `tax_usd`.

`GET /v1/status` carries `executable` (2026-10-18): the binary the daemon
runs from, with a Homebrew keg path (`<prefix>/Cellar/caprock/<v>/bin/caprock`)
given as `<prefix>/bin/caprock`, which survives an upgrade; omitted when the
path cannot be read. Settings puts it in the MCP command when asked.

**Registering it with the agents** (2026-10-22, ADR-078 amended). Code:
`internal/mcpreg`, `internal/api/mcpreg.go`. Nothing here runs except on a
click.

- **`GET /v1/mcp/agents`** → `{executable, unstable?, agents: [{agent:
  "claude"|"codex", name, state, command?, config?}]}`. `state` is
  `not_installed` (the CLI is not found the way a spawned agent's is: the
  daemon's PATH, the login shell's, the installers' directories),
  `not_connected`, `connected`, or `different` (a `caprock` entry whose
  command is another path, or whose arguments are not `["mcp"]`: a stale
  path). Read from the agent's own file, never by running it: Claude Code's
  user scope is the top-level `mcpServers.caprock` of `.claude.json` in
  `$CLAUDE_CONFIG_DIR` or the home directory (project-scoped entries are not
  read); Codex's is the `[mcp_servers.caprock]` table of `config.toml` in
  `$CODEX_HOME` or `~/.codex`, read line by line (`command = "…"`,
  `args = [ … ]`). Either override is taken from the login shell's
  environment. A registered `command` counts as this caprock when it equals
  `executable`, is a bare `caprock` (the copy command), or resolves through
  links to the same file. A file that cannot be read or parsed reads as
  `not_connected`. The parse is cached on the file's size and mtime.
  `executable` is `/v1/status`'s; `unstable` says why Connect would refuse it
  (a macOS App Translocation path, an app on a mounted disk image, a
  `go run` build). 501 when the daemon has no registrar.
- **`POST /v1/mcp/agents/{agent}/connect`** runs, with the login shell's
  environment, from the home directory, no stdin, a one-minute bound:
  `claude mcp add -s user caprock -- <executable> mcp` or `codex mcp add
  caprock -- <executable> mcp`. `different` first runs the remove below;
  `connected` runs nothing. → `200` and the agent's new status.
- **`POST /v1/mcp/agents/{agent}/disconnect`** runs `claude mcp remove -s
  user caprock` or `codex mcp remove caprock`; `not_connected` runs nothing.
  → `200` and the new status.
- **Errors** are `{error, agent}`: `403` from any paired device (a phone or
  an allowed computer: this changes the machine's agent config), `404` an
  agent other than `claude` or `codex`, `409` not installed or an unstable
  path, `502` the CLI failed — `error` is `<Name>: ` and the last 600
  characters of what it printed. One change runs at a time.

### AI;DR

One agent answer squeezed into at most two short sentences, on the user's
tap ([ADR-072](08-decisions.md)). No screen calls it since 2026-10-21, when the
phone's latest-answer card was removed; it stays for other clients. A caller sends `Content-Type: application/json`
and body `{}`: over access from anywhere the channel drops Origin and Sec-Fetch-*,
so that header is the only CSRF proof (`csrf.go`). Code: `internal/api/tldr.go`,
`internal/brain/tldr.go`, `internal/store/tldr.go`; DDL in § AI;DR DDL
(migration 0060).

```
POST /v1/events/{id}/tldr   (body {}) → 200 {tldr: string, cached: bool} | 404 {error} | 502 {error} | 503 {error}
```

- **`{id}`** is the answer's event id, the `event_id` of `/v1/notes`,
  `/v1/sessions/{id}/notes` and a brain drop. It must be main-thread
  assistant prose (§ Phase 0's notes rules, `store.BrainNoteSource`); any
  other event, an unknown id or one that is not a number is `404`.
- **A short answer is its own TL;DR.** Fewer than 280 runes after trimming:
  `{tldr: <the answer, trimmed>, cached: false}`, no call, nothing kept.
- **Kept.** A squeeze is kept in `event_tldr`; a later tap returns it with
  `cached: true` and makes no call. A failed call keeps nothing, so the next
  tap tries again.
- **The call.** Second Brain's runner (`brain.ClaudeRunner`, flags in
  ADR-063: `claude -p --output-format json --tools "" --no-session-persistence
  --setting-sources local --settings <hooks off>`), with `--model haiku`,
  `--system-prompt` the AI;DR instructions (`brain.TLDRSystem`: the answer's
  own language, at most 2 sentences and 220 characters, decisions, numbers
  and the next action kept, no preamble) and no `--json-schema`; the answer
  goes on stdin and the reply is claude's `result` text. A Windows `.cmd`
  shim gets the instructions on stdin too. An answer longer than 12,000
  runes is sent as its first 4,000 and its last 8,000 around a marker: an
  agent says what it did first and its result and next step last. The
  reply is trimmed of a `TL;DR:` label and wrapping quotes, joined onto one
  line and clipped to 300 runes. Never typed into the session; the
  session's transcript is not touched, and the call writes none of its own.
- **One call per answer.** Taps on the same answer while its squeeze runs
  wait on that one call. The call runs under its own one-minute deadline,
  not the request's: a tap that gives up does not stop it, and its result is
  kept for the next tap.
- **`503`** — no usable claude: the binary is not found (`brain.ErrNoClaude`)
  or the build wires no runner. **`502`** — claude ran and failed or did not
  answer within a minute; `error` says which.
- **Who.** The machine, and a paired controller phone (`controllerRoutes`);
  a viewer gets `403`.

### Queued messages

What the chat field sends to a session Caprock started ([ADR-053](08-decisions.md)).
Code: `internal/daemon/queue.go`, `internal/api/queue.go`,
`internal/store/queued.go`, `ui/src/lib/queue.ts`, `ui/src/components/QueuedList.tsx`.

```
GET    /v1/agents/{id}/queue                → QueueView
POST   /v1/agents/{id}/queue                {text} → {sent: bool, queued?: QueuedMessage, queue: QueueView}
PATCH  /v1/agents/{id}/queue/{qid}          {text} → QueueView
DELETE /v1/agents/{id}/queue/{qid}          → QueueView
POST   /v1/agents/{id}/queue/{qid}/send     → QueueView; 409 while a prompt or a question is on the screen
```

- **`QueueView`** — `{session_id, messages: [QueuedMessage], waiting}`;
  `QueuedMessage` is `{id, session_id, text, created_at, updated_at, via?}`
  (unix ms), oldest first; `via` is `"telegram"` for a message forwarded to
  the paired bot (§ Telegram bridge, migration 0064) and absent otherwise. `waiting` says what holds a message: `"turn"` (the
  agent is working), `"permission"` (a permission prompt is on the screen),
  `"question"` (AskUserQuestion), or `""` (nothing; the session is at its
  prompt).
- **Send or queue.** `POST …/queue` types the text in at once when
  `waiting` is `""` and nothing is queued; otherwise it appends the text
  (`sent: false`, `queued` set). A message typed in counts as a running turn
  for 15 s or until the session's next hook.
- **How a message is typed** (every path: the chat field, the phone, *Tell
  the agent*, a delivery at a turn's end, Send now, a Telegram reply) — two
  writes, `internal/daemon/queue.go` `typeMessage`:
  - **The text.** Control characters dropped, a tab as two spaces, a space
    after a trailing `@file`. When the session's output has turned
    bracketed paste on (`ESC[?2004h`, read from its terminal ring; Claude
    Code and Codex both do), the text goes as a paste, `ESC[200~` … `ESC[201~`,
    each line break as `\r`. Otherwise it is typed, each line break as ESC
    CR.
  - **The Enter.** `\r` on its own, 200 ms later plus 25 ms per 256 bytes of
    the text (at most 1 s).
  - **The check.** 1.5 s after the Enter, when no hook has come from the
    session since, no permission prompt is pending, no menu is on its
    screen, and the prompt still shows the text (the end of its last line,
    or a `[Pasted text #…]` / `[Pasted Content …]` placeholder, inside
    Claude Code's input box or in the last 8 rows), `\r` is pressed once
    more. Once only.
- **Delivery.** On the session's own `Stop` hook — main thread, recorded,
  and not answered with "keep going" by the task runner's Stop-loop — the
  daemon waits 700 ms, reads `waiting` again, and when it is `""` types the
  oldest message in and deletes it: one message per turn. Nothing else
  delivers: not silence, not `StopFailure`. On start the daemon delivers to
  a surviving session that sits at its prompt.
- **When `waiting` is known.** Only for Claude Code sessions whose hooks
  record: the newest main-thread hook event among `turn.user`, `tool.pre`,
  `tool.post`, `permission.prompt`, `context.compact` (trigger `auto`),
  `agent.stop`, `agent.spawn` (not source `compact`), `context.clear`,
  `session.continue`, `throttle` and `session.end`, plus the manager's
  pending prompt. Another agent, or Claude Code without hooks, is always
  `""`: the message is typed in at once, as before.
- **Limits.** `text` has trailing whitespace trimmed, must have something
  left, be valid UTF-8 without NUL, at most 16 KiB (`400` otherwise). At
  most 20 per session (`409`). An id the session does not hold is `404`.
- **Rule 7.** Only sessions Caprock started and that still run: anything
  else is `409` for a write and an empty queue for a read. A session's rows
  are deleted when its process exits, on `SessionEnd` with an exit reason,
  and on start for sessions that did not survive.
- **Who.** `GET` is open to every paired device; the writes to a
  controller, as `POST /v1/agents/{id}/input` is.
- **Frames.** Every change publishes a `queue` frame with the QueueView.
- **From Telegram.** A forward to the paired bot (§ Telegram bridge) is sent
  through the same path with `via: "telegram"`: kept on its row while held,
  and, within 30 s of being typed in, put on the payload of the session's
  next main-thread `UserPromptSubmit` event as `"via": "telegram"` before it
  is recorded (hookd's `Annotate`). The chat and the queue show *from
  Telegram* under such a message.

### Queue

The Queue view (Tasks → Queue, `#/queue`): across the sessions Caprock
started, what each is doing, what waits in its message queue (§ Queued
messages) and roughly when each message starts and is done, and the turns
finished lately. Code: `internal/daemon/queueboard.go`, `internal/eta`,
`internal/store/turns.go`, `internal/api/queueboard.go`,
`ui/src/components/QueueView.tsx`, `ui/src/lib/queueboard.ts`.

```
GET /v1/queue → QueueBoard
```

- **`QueueBoard`** — `{now, sessions: [BoardSession], done: [BoardDone],
  done_since}`. `now` is the daemon's clock (unix ms); every estimate is in
  ms from it. `sessions` is every session Caprock started and still runs
  (shells left out): working first, then waiting on a prompt, then at their
  prompt, each group by project.
- **`BoardSession`** — `{session_id, agent, title?, project?, dir?, branch?,
  waiting, turn_started_at?, todo?, queue: [BoardItem], turn_left?, free_in?,
  estimate?, estimate_note?}`. `dir` is the project estimates group by (the
  repository root, else the folder, as Cost groups). `waiting` is the queue's
  own (§ Queued messages). `turn_started_at` is the running turn's prompt
  (unix ms), else when Caprock last typed into it. `todo` is
  `{active?, done, total}` from Session todos, cancelled items left out,
  `active` the in-progress item's `active_form` (else its text).
  `BoardItem` is a `QueuedMessage` plus `position` (1 = typed in when this
  turn ends), `start?` and `finish?`. `ETA` is `{lo_ms, mid_ms, hi_ms}`:
  median and the 25th–75th percentile range. `free_in` is when a message
  added now would start (0 at the prompt with nothing queued).
- **A turn** is a Claude Code main-thread turn on the hook plane: from
  `turn.user` to the next `agent.stop` without an agent id, or `throttle`
  (then `failed`). A second prompt before any Stop means the first was
  interrupted and is not a turn. No other agent records when a turn ends,
  so only Claude Code with hooks has estimates; the others carry
  `estimate_note` and no `free_in`.
- **`estimate`** is `{turns, p25_ms, median_ms, p75_ms}` over the project's
  newest 200 finished turns of the last 90 days (any session in the
  project, started by Caprock or not), read through
  `idx_events_turn_bounds` (migration 0048) and kept for 2 minutes per
  project. Under 5 turns there is no `estimate`, only `estimate_note`
  ("3 turns finished in this project so far; an estimate needs 5").
- **The arithmetic** (`internal/eta`). The running turn's remaining time
  (`turn_left`) is the median, p25 and p75 less the time it has run, floored
  at 0, while it has run less than the median; past the median it is the
  quantiles of what the past turns that ran at least that long still took
  (none when fewer than 5 did). The message at `position` p starts after the
  remaining time plus p − 1 typical turns and finishes one turn later; each
  bound adds its own quantile (lo adds p25, hi adds p75). At the prompt
  with nothing queued the remaining time is 0. No `start`/`finish` while a
  permission prompt or question waits, when the turn has outlasted the
  history, or when messages are left at the prompt (they wait for Send now).
  How good this is was measured before it was shown: [12-risks.md
  RISK-08](12-risks.md#risks) — about as wrong as a typical turn is long, the
  ranges calibrated, so the UI shows ranges, the word "rough" and the basis.
- **`BoardDone`** — `{session_id, agent, title?, project?, prompt, started_at,
  ended_at, queued?, failed?}`: the turns of sessions Caprock started that
  ended in the last 3 hours (`done_since`), newest first, at most 30;
  `prompt` clipped to 200 characters. `queued` marks a prompt that was a
  queued message the daemon typed in (remembered in memory: the last 200,
  not across a restart).
- **Live.** Nothing polls. The page reads the board again (at most once a
  second) on a `queue` or `permission` frame, an `event` frame of kind
  `turn.user`, `agent.stop`, `throttle`, `agent.spawn`, `session.end` or
  `permission.prompt`, a `tool.pre` of `TodoWrite`, `TaskCreate`,
  `TaskUpdate` or `update_plan`, a `session` frame that ends a session, a
  `reset`, and a reconnect; ages tick on the page's own clock.
- **Adding** goes through `POST /v1/agents/{id}/queue`. "Whichever is free
  first" is decided on the page: the project's session with the smallest
  `free_in.mid_ms`, else a Claude Code session at its prompt with nothing
  queued, else the shortest queue; never one waiting on a prompt or a
  question. Only sessions on the board are offered: Caprock's own (rule 7).
- **Done notification.** When the Stop (or StopFailure) that ends a queued
  message's turn arrives, the alert rules decide a `finished` alert at once
  (`Rules.QueuedDone`) instead of after the quiet minute, which never comes
  while the next message goes straight in. Same switches (`notify_approval`
  for one that asks, none on the desktop for one that does not; `alert_finished`
  and `alert_done`), per-session 3-minute cooldown and hourly cap; the title
  is `Queued message done · <project>` and the body adds `Queued: <the
  message, 100 characters>`. A message typed in at once (the session was at
  its prompt) is an ordinary turn and gets the ordinary finished alert.
- **Who.** A read open to every paired device, as the per-session queue is.
  `501` without a queue (a test server).

### Work

The Work board ([ADR-064](08-decisions.md)): a branch is the unit of work.
Across every live session on the machine — started by Caprock or by hand —
what is being worked on, by whom, roughly how long the running turn has
left, what it cost today, what is planned (the task runner's tasks and the
queued messages) and what each repository has merged and not released.
Columns are derived on the page from this answer and the Pipeline's board
(`GET /v1/repos/ci`, `board`), joined by branch; nothing is stored. Code:
`internal/daemon/workboard.go`, `internal/relplan`,
`internal/store/workspend.go`, `internal/api/work.go`.

```
GET /v1/work → Work
```

- **`Work`** — `{now, day_start, sessions: [WorkSession], tasks?:
  [WorkTask], hive, queued: [WorkQueued], repos: [WorkRepo], totals}`.
  `now` is the daemon's clock (unix ms), every ETA in ms from it;
  `day_start` the local midnight today's figures count from. `hive` is
  `on` or `off`; `tasks` is absent when the task runner is off. `totals`
  is `{live, working, waiting_you, today_usd, machine_today_usd}`:
  `today_usd` sums the live sessions', `machine_today_usd` is every
  session's priced cost since `day_start` (internal model work left out).
- **`WorkSession`** — `{session_id, agent, owned, model?, model_display?,
  subscription?, name?, description?, description_source?, project,
  repo_root?, worktree?, branch?, on_default?, started_at, worked_at?,
  state, turn_started_at?, turn_left?, estimate?, estimate_note?, todo?,
  cost_usd, today_usd, prs: [{number, url, title?, opened_at?,
  merged_at?}], link, link_note?}`. Every session not ended, shells left
  out, at most 200: waiting on you first, then working, background, at
  the prompt, each by project. `description` is the session list's.
  `on_default` is whether `branch` is the remote's default branch as the
  clone knows it, absent when either is unknown. `prs` are the session's
  recorded pull requests (§ session_prs), newest four. `cost_usd` is the
  session's total, `today_usd` its priced cost since `day_start`
  (`store.SpendBySessionSince`: one grouped sum over
  `idx_events_attr_work`, which covers it).
- **`state`** — `working`, `permission`, `question`, `at_prompt` or
  `background` (the turn ended, subagents it started still work). A
  Caprock-started Claude Code session reads the queue's own waiting
  (§ Queued messages); one started by hand reads its newest main-thread
  hook event the same way, except that a permission prompt is the dialog
  still on its screen (no manager holds it); a session whose hooks cannot
  say (another agent, Claude Code without hooks) reads as the Now screen
  narrates its newest main-thread events.
- **Estimates** — the Queue's, unchanged (§ Queue, RISK-08): Claude Code
  only, the project's newest finished turns, `turn_left` only while
  `working` and never while it waits on you (`estimate_note` says why
  there is none). Hand-started Claude Code sessions get them too: the
  turns come from the hooks either way. No task completion time, no
  per-PR merge countdown, no clock time for the next release.
- **`todo`** is `{active?, done, total}` as on the Queue, kept while the
  session's `last_event_at` has not moved and for at most 2 minutes.
- **`link`** — how the session is tied to a pull request: `recorded` (its
  own `gh pr` commands named one), else `branch` (it works on a branch
  that is not the default, so a pull request whose head is that branch is
  its), else `none` with `link_note`. Never guessed from a title.
- **`WorkTask`** — `{id, title, status, session_id?, branch?, budget_usd,
  spent_usd}`: every task not done or failed, and those finished in the
  last 24 hours. `branch` is the worker's `caprock/<assignee>`;
  `session_id` the open assignment's.
- **`WorkQueued`** — `{session_id, position, text, start?, finish?}`: the
  messages in owned sessions' queues, `text` clipped to 200 characters,
  `start`/`finish` as the Queue's.
- **`WorkRepo`** — `{root, name, remote?, via_session, live, unreleased?,
  tags?, ahead_of_tag?}`: the live sessions' repositories (most live
  sessions first), then those any session recorded something in within 24
  hours (newest first), at most 8. `remote` is `owner/name` from origin's
  web address; `via_session` the newest session that brought it; `live`
  how many live sessions it has. `unreleased` `{ref, items, count, more?,
  kinds?}`
  is the `CHANGELOG.md` `[Unreleased]` section at the remote's default
  branch as the clone knows it (`ref`, `origin/<default>`, from
  `refs/remotes/origin/HEAD`): `items` the first lines of its top-level
  bullets, at most 30, nested bullets and sub-headings dropped. A
  repository that keeps one file per change (`changes/unreleased/*.md` at
  that branch, front matter skipped; Caprock's own since 2026-10-15) has
  those files' top-level bullets added after the section's, in file-name
  order, and `count` covers both. `kinds` (since 2026-10-15) counts the
  entries by Keep a Changelog kind — `Added`, `Changed`, `Deprecated`,
  `Removed`, `Fixed`, `Security`, as `{"Added": 2, "Fixed": 3}` — from the
  `### ` heading an entry sits under in the section and a fragment's
  `kind:`, case ignored; an entry under no such heading, or a fragment
  without front matter, counts in `count` only; absent when no entry has a
  kind. The release plan predicts the next version from it (04-ui.md §
  Release plan). Absent when neither the section nor the
  directory is there. `tags` `{last?: {name, at},
  gap_median_ms?, gaps}` reads the newest 11 tags by creation date;
  `gap_median_ms` is the median time between them, absent with fewer than
  three gaps. `ahead_of_tag` counts the default branch's commits past the
  last tag.
- **Local only.** Git is read, never fetched: `git show <ref>:CHANGELOG.md`,
  `git ls-tree <ref> changes/unreleased/` and one `git cat-file --batch`
  for the fragments,
  `git for-each-ref refs/tags --sort=-creatordate --count=11`, `git
  rev-list --count`, `git symbolic-ref`, `git remote get-url origin`, each
  hidden on Windows (`internal/hidewin`). A repository's reads are kept 60
  seconds, and the CHANGELOG is reused while the default branch's commit
  has not moved. Everything from git is only as fresh as the user's last
  fetch, and the page says so. GitHub is never asked by this route. Nothing
  is written. No DDL.
- **Live.** Nothing polls: the page asks again on live frames, as the Queue
  does.
- **Cost.** Measured 2026-10-15 on a copy of the owner's database (1.69 GB,
  534,812 events, 6 live sessions, 2 repositories), without an agent
  manager: 9.0 ms median warm (p90 9.5 ms), 380 ms for the first answer,
  which reads the repositories and the turn history; re-reading two
  repositories' git took 110–150 ms. The today's-spend sum took 1.7 ms
  cold, 0.5 ms warm.
- **Who.** A read open to every paired device, as the Queue is. `501`
  without a work board (a test server).

### Pipeline agents

The Pipeline's two agent figures for one repository — what an hour of agent
work costs and how many agents worked ([04-ui.md](04-ui.md) § The Pipeline,
*The agent figures*). Measured from the events of the sessions whose
`repo_root` is one of the folders named; nothing is stored. Code:
`internal/store/pipelineagents.go`, `internal/api/pipelineagents.go`.

```
GET /v1/pipeline/agents?repo=<root>[&repo=<root>…] → RepoAgents
```

`repo` is required (a 400 without one, and above 32): every folder of the
repository, as clones of one GitHub repository are several. Read-only, so a
paired device may ask it.

- **`RepoAgents`** — `{days, rate, team}`; `days` is 14, the window the
  usuals are set against.
- **`rate`** — `{last24, usual?, series}`, each a `RateSpan` `{cost_usd,
  active_hours, active_cost_usd, tokens, active_tokens, wall_hours, days?}`.
  An **active agent-hour** is `usual.burn`'s rule (`UsualMinCalls`): one
  session's clock hour — local, counted from a local midnight — in which
  it made at least five priced calls costing more than nothing, its
  subagents' turns included, since they are rows of the same session. Two
  sessions in one clock hour are two agent-hours; `wall_hours` counts that
  hour once, as any hour with a priced turn. The rate is
  `active_cost_usd / active_hours`; spend in an hour below the rule is in
  `cost_usd` but not in the rate. `tokens` is input, output, cache reads and
  writes; `active_tokens` the active hours' share. `last24` is the last 24
  clock hours, the current one included; `usual` the 14×24 hours before
  them, with `days` the 24-hour stretches among them that had an active
  hour, absent when none had. `series` is the previous 14 local days,
  oldest first, then today so far. The client withholds a comparison below
  three `days`: "not enough history".
- **`team`** — `{now, peak_today, series}`. An agent is a main session
  (`agent_id` empty) or a subagent (one `agent_id` in one session — the
  harness's agent id, which the hooks carry inside a subagent, § Subagent
  reads DDL) with an assistant turn. `now` is `{sessions, subagents}` with
  a turn in the last ten minutes (the five-minute bucket the ten begin in
  counts whole). `series` is the previous 30 local days, oldest first, then
  today: `{day, sessions, subagents, by_kind?, peak}`, distinct agents that
  day, `by_kind` the same split by `sessions.agent` (`claude`, `codex`,
  `opencode`, `gemini`, …), and `peak` the most agents with a turn in one
  five-minute bucket (five minutes divides every UTC offset, so a bucket
  never straddles a local midnight); `peak_today` is today's.

One grouped scan per figure, off the covering `idx_events_turn_agent`
(`kind, ts, session_id, agent_id, … cost_usd, tokens…, internal`): per
(session, hour) for the rate, per (session, agent id, five-minute bucket)
for the team, the session set a subquery off `idx_sessions_repo_branch`.
The whole window is too slow to ask once a minute — on a 1.7 GB copy of the
owner's database, for its busiest repository (2026-10-15, through the Go
driver, warm): 105 ms for 16 days of the rate and 125 ms for 31 days of the
team; 34 ms and 122 ms in the sqlite shell. So the window is cut at today's
local midnight: the days before are scanned once and kept per folder set
and day for 30 minutes (`pipeAgentsPastTTL`; a transcript read late still
reaches them), as hourly sums and finished days, and a request scans only
today — 26 ms warm for both figures together at 20:30 on that repository's
busiest day, 5–8 ms for a quieter one, against 300 ms once a day for the
days before. The answer itself is cached for a minute (`pipeAgentsTTL`).

### Chat field pickers

The chat field's `/` and `@` pickers ([ADR-053](08-decisions.md)). Code:
`internal/slashcmd`, `internal/api/pickers.go`, `ui/src/lib/pickers.ts`,
`ui/src/components/ChatPicker.tsx`.

```
GET /v1/sessions/{id}/commands   → {agent, commands: [{name, description?, hint?, source}]}
GET /v1/sessions/{id}/files      → {files: [string], truncated?}
```

- **Commands.** `source` is `builtin`, `project`, `user`, `project skill` or
  `user skill`. Claude Code (`agent` empty or `claude`): its built-in
  commands that make sense typed from a chat, then `.claude/commands/**/*.md`
  (named by file; a subfolder does not rename) and `.claude/skills/*/SKILL.md`
  (front matter `name`, else the folder) of the session's `cwd` and of its
  repository root, then the same under `~/.claude`. A name already listed is
  not listed again. `description` is the front matter's, else the first
  line; `hint` is `argument-hint`. Codex: its built-ins and
  `~/.codex/prompts/*.md` as `prompts:<name>`. Any other agent: none. At
  most 400 files read, 4 KiB of each. `404` for an unknown session.
- **Files.** The files under the session's `cwd`, relative to it, listed as
  `GET /v1/projects/{id}/files` lists a project's (tracked and
  untracked-not-ignored files in a repository, a walk otherwise; at most
  20,000). `404` when the folder is gone; `501` without the projects service.
- **Who.** Both are reads open to every paired device. A pick only puts
  text in the field.

### Changes: a worktree's status, diff, commit and push

Review a worktree's uncommitted work and commit, push or pull it without a
terminal ([04-ui.md § The app workspace](04-ui.md#the-app-workspace),
Changes view). Code: `internal/projects/changes.go`,
`internal/api/changes.go`. A worktree is named by `?worktree=<name>` — git's
name, as in `Worktree.name` — on every route; absent or empty is the
project's main checkout. An unknown project or worktree is `404`.

```
GET  /v1/projects/{id}/changes[?worktree=]                          → Changes
GET  /v1/projects/{id}/changes/diff?path=<p>[&staged=1][&worktree=] → FilePatch
POST /v1/projects/{id}/changes/stage[?worktree=]    {paths} | {all: true} | {hunk: Hunk} → {changes}
POST /v1/projects/{id}/changes/unstage[?worktree=]  {paths} | {all: true} | {hunk: Hunk} → {changes}
POST /v1/projects/{id}/changes/discard[?worktree=]  {paths} → {preview}; {paths, confirm} → {changes}
POST /v1/projects/{id}/changes/commit[?worktree=]   {message, all?} → {commit: CommitResult, changes}
POST /v1/projects/{id}/changes/push[?worktree=]     → {result: RemoteResult, changes}
POST /v1/projects/{id}/changes/pull[?worktree=]     → {result: RemoteResult, changes}
POST /v1/projects/{id}/changes/fetch[?worktree=]    → {result: RemoteResult, changes}
```

- **`Changes`** — `{project_id, worktree, path, branch, detached?, head?,
  upstream?, ahead, behind, remote?, remote_url?, default_branch?, published,
  state?, staged: [ChangeFile], unstaged: [ChangeFile], conflicted:
  [ChangeFile], truncated?, token, at}`. From one `git status
  --porcelain=v2 -z --branch --untracked-files=all` plus `git diff
  --numstat` of each side and one `git config --get-regexp` for remotes and
  tracking. `remote` is where a push goes: the branch's tracked remote, else
  `origin`, else the only remote. `published` is true when the branch tracks
  the same-named branch on `remote` — what a pull request is opened from.
  `default_branch` is `refs/remotes/origin/HEAD`, else `main` or `master`.
  `state` is `merging`, `rebasing`, `cherry-picking` or `reverting`.
  `token` changes whenever the status does. At most 3,000 files
  (`truncated`).
- **`ChangeFile`** — `{path, orig_path?, status, additions, deletions,
  binary?}`; `status` is `added`, `modified`, `deleted`, `renamed`,
  `copied`, `typechange`, `untracked` or `conflicted`. A file can be in
  `staged` and `unstaged` at once. A rename carries `orig_path` (staged
  side). An untracked file's `additions` are its lines (files up to 1 MB,
  the first 300 files).
- **`FilePatch`** — `{path, orig_path?, staged, status, patch, binary?,
  truncated?, too_large?, bytes, token}`: `git diff` of the index against
  HEAD (`staged=1`, `-M`, a rename names both paths) or of the working tree
  against the index; a new file against nothing (`--no-index`, its header
  written as `a/<path>`); `--no-color --no-ext-diff`. Cut at 1 MB on a line
  boundary (`truncated`, `bytes` the whole); a new file over 16 MB is not
  diffed (`too_large`). `token` names this exact patch.
- **Paths.** Every `path`/`paths` entry must be relative, clean (no `.`,
  `..`, doubled or trailing separator, NUL), and listed in the worktree's
  status in the area the call acts on; otherwise `400` (malformed) or `409`
  (`stale`: not a change there now). Git runs with `--literal-pathspecs`, so
  `*` or `:(top)` is a file name. Nothing outside the worktree is read or
  written.
- **Stage and unstage.** Files: `git add -A -- <paths>` / `git restore
  --staged -- <paths>` (`git rm --cached` before the first commit; a staged
  rename unstages both paths); `all`: `git add -A` / every staged change.
  `Hunk` is `{path, index, token}`: hunk `index` (0-based) of the
  `FilePatch` whose `token` the caller saw, applied with `git apply
  --cached` (`--reverse` to unstage); a different token is `409 stale`.
  Only a `modified` text file's hunks; anything else is staged as a file
  (`400`).
- **Discard** acts on unstaged changes only: a tracked file is restored
  from the index (`git restore --worktree`), an untracked file is deleted
  (the link itself for a symlink; empty folders it leaves are removed; a
  path through a symlinked folder out of the worktree is refused). Staged
  changes and conflicts are never touched. Two calls: without `confirm` it
  changes nothing and answers `{preview: {confirm, files}}`; `confirm` is a
  hash of the files' status records and their size and modification time,
  so with it, and nothing changed since, the second call discards. A file
  changed in between is `409` `{kind: "stale", preview}` with the fresh
  token.
- **Commit.** `message` is required (trimmed; empty is `400`, over 64 KB or
  with NUL is `400`); `all` stages everything first; nothing staged is
  `409`, a conflict is `409`. `git commit -F -` with the message on stdin,
  so the author and committer are what the user's git config says, and
  hooks run (`pre-commit`, `commit-msg`, …; never `--no-verify`) under a
  3-minute timeout with the login shell's environment. `CommitResult` is
  `{sha, short, subject, output}`, `output` being git's and the hooks' lines.
  A hook that refuses is `422 {kind: "hook", output}`, and what was staged
  stays staged.
- **Push** sends the checked-out branch to the same-named branch on
  `remote`: `git push [--set-upstream] -- <remote>
  refs/heads/<b>:refs/heads/<b>`, with `--set-upstream` when it is not
  `published` (a first push, or a worktree created to track the trunk), and
  never `--force`. Detached, no commit yet, or no remote is `409`.
  `RemoteResult` is `{remote, branch, upstream_set?, output}`. **Pull** is
  `git pull --ff-only --no-rebase` from the upstream (none: `409`). **Fetch**
  is `git fetch --prune -- <remote>`. Remote commands run under 2 minutes
  with `GIT_TERMINAL_PROMPT=0` and the login shell's environment (ssh agent,
  credential helpers), never prompting.
- **Failures** are `{error, kind, output?}`: `400 invalid`, `409 state` or
  `stale`, and `422` for `auth` (the remote refused the credentials),
  `network`, `rejected` (the remote has commits the branch lacks — pull
  first), `diverged` (a pull cannot fast-forward), `hook`, `timeout` and
  `git` (anything else, with git's last lines). `output` is the last 32 KB
  of what the command printed.
- **Concurrency and liveness.** Writes to one worktree are serialised.
  Every write answers with the status after it and asks the project's git
  watcher to refresh, so a `project` frame follows; the UI reads the status
  again on that frame. Nothing here runs on a timer.
- **Who.** The two `GET`s are open to every paired device; the writes are a
  controller's (ADR-034 amended 2026-10-06) and, from a device, only in a
  project under home whose worktree folder resolves under home (`403`
  otherwise). A device's discard, commit, push, pull and fetch are logged
  with its id.
- **For a pull request (WP-19).** `branch`, `published`, `remote`,
  `remote_url`, `default_branch`, `ahead` and `head` say whether a worktree
  can open one and against what; `POST …/changes/push` publishes the branch
  first. In Go, `projects.Service.Push(ctx, id, worktree)` and `Changes`
  are the calls a PR endpoint can make before talking to GitHub.

### Files: read a project's file

One file of a project, read-only, and the list of its files, for the app's
file tab and the palette's *Open file…* ([04-ui.md § The app
workspace](04-ui.md#the-app-workspace), File tabs). Code:
`internal/projects/files.go`, `internal/api/files.go`. `?worktree=` names a
linked worktree as in Changes; absent or empty is the project's root —
for a plain folder project too. An unknown project or worktree is `404`.

```
GET /v1/projects/{id}/file?path=<p>[&worktree=]  → FileContent
GET /v1/projects/{id}/files[?worktree=]          → {files: [string], truncated?}
GET /v1/projects/{id}/image?path=<p>[&worktree=] → the picture's bytes
```

- **`FileContent`** — `{path, size, text, truncated?, binary?, lang}`.
  `size` is the whole file's; `text` is at most its first 1 MB
  (`truncated`), cut on the last line break within the final 4 KB, else on
  a whole UTF-8 character. `binary` — a NUL byte or invalid UTF-8 in what
  was read — sends no `text`. `lang` is named from the extension
  (`markdown` for `.md`, `.mdx`, `.markdown`; `go`, `typescript`, … ;
  `text` when unknown) and only decides whether the tab renders Markdown.
- **Paths.** `path` must be relative and clean — no `.`, `..`, doubled or
  trailing separator, NUL, absolute path, or (on Windows) backslash —
  else `400`. The folder and the path are then resolved with every symlink
  followed; a real location outside the folder's own real location is
  `403`, so neither `..` nor a symlink (to a file or through a folder) reads
  anything outside the project. Only a regular file: a folder, socket,
  device or FIFO is `400` (checked before opening, so a FIFO never blocks);
  a missing file or a dangling link is `404`.
- **`image`** is a picture a rendered Markdown file shows, sent as bytes
  under its own type, by the same path rules as `file`. Only `.png`,
  `.jpg`/`.jpeg`, `.gif`, `.webp`, `.avif`, `.svg`, `.bmp` and `.ico`
  (`415` otherwise), at most 10 MB (`413`). Sent with `X-Content-Type-Options:
  nosniff`, `Cache-Control: no-store` and `Content-Security-Policy:
  default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an SVG opened
  on its own runs no script. The file tab fetches it with the device token
  and shows it from an object URL; an image on the web is never fetched.
- **`files`** is `git ls-files -z --cached --others --exclude-standard` in
  a repository (tracked files and new ones git does not ignore), else a walk
  that skips dot-folders, `node_modules` and symlinked folders; sorted, at
  most 20,000 (`truncated`). The palette filters it in the browser.
- **Who.** All three are reads, open to every paired device as a worktree's
  diff is (`pairedDeviceRoutes`). Nothing here writes, and no route is added for
  a controller. On macOS a folder behind a privacy prompt is refused as the
  Changes routes refuse it (`tcc`).

### Mail (`/v1/mail/*`)

Caprock Mail ([ADR-057](08-decisions.md)). Code: `internal/mail` (HTTP in
`http.go`), `internal/mail/engine` (IMAP, SMTP), `internal/mail/mailstore`
(DDL in `schema.sql`), `internal/mail/oauth` (sign-in with Google and
Microsoft; HTTP in `http_oauth.go`), `ui/src/screens/mail`. Every write is
JSON, as the CSRF guard requires. Before the first account exists only `GET
/v1/mail/state`, `GET /v1/mail/providers`, `GET /v1/mail/oauth/providers`, `GET
/v1/mail/oauth/flow`, `GET /v1/mail/import`, `GET /v1/mail/settings` (the defaults) and `GET
/v1/mail/messages` (`[]`) answer without opening Mail.

- `GET /v1/mail/state` — `{accounts, folders, counts: {inbox, unread, flagged, junk}, version, sample, triage}`; `version` moves on every local change and is what the screen polls; `sample` is true while sample mode is on. **Spam in the inbox** is one notion everywhere (`mailstore.SpamSQL`): a message the junk filter flagged (`junk`) or whose conversation the AI triage labelled `spam`. `inbox` and `unread` (and each inbox folder's `unread`) leave spam out; `junk` counts the inbox conversations that are spam (not the Junk folder). `triage` is `{running, pending, by, counts: [{account_id, category, n}]}`: whether a sorting run is on and how many conversations it has left, who sorts (`"Claude Code · haiku"`, `"Sample labels"`), and per account and category the inbox conversations with that label — where `spam` is the same union (a conversation the filter caught counts as `spam` whatever the AI said), so the inbox's Spam filter, its count and `junk` agree.
- `POST /v1/mail/sample` — `{on}` → `{sample}`. On: two sample accounts on in-process fake servers, a database in a temporary directory and passwords in memory; while it is on every `/v1/mail` route serves the sample, and the real `mail.db` and keychain are not touched (an unused Mail stays unopened). Off: the sample is dropped and the routes serve the real data again. Adding a real account — `POST /v1/mail/accounts`, `POST /v1/mail/import`, a finished OAuth sign-in — turns it off before anything is stored (an added or signed-in account once it has passed its check), so the account lands in the real `mail.db` and the user's mail replaces the sample. `CAPROCK_MAIL_DEMO=1` turns it on for the whole run and `{on: false}` is then `409` (an account added in that run goes to the sample). A mutating route, behind the CSRF guard and pairing like the rest.
- `GET /v1/mail/providers?email=` — server settings for an address: `{provider, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, note, help_url, known, needs_username, username, source}`. Lookup order, first answer wins, `source` says which: `preset` — the domain is in the table in `internal/mail/providers/providers.go` (about 40 consumer services, each entry citing the provider's own settings page); `mx` — the domain's MX points at a host in that table (Google Workspace, Microsoft 365, iCloud+, Zoho, Fastmail, Yandex 360 and the hosts people put their own domain on: Rackspace, GoDaddy, Namecheap Private Email, Spacemail, IONOS, OVHcloud, Hostinger, Titan, Infomaniak, STRATO, Migadu and others; the longest matching hint wins); `srv` — RFC 6186 records `_imaps._tcp` / `_imap._tcp` and `_submissions._tcp` / `_submission._tcp` (implicit TLS preferred; an IMAP record is required); `autoconfig` — the domain's own Thunderbird-format file, `https://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=<addr>` then `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`, SSL or STARTTLS servers only, `%EMAILADDRESS%` / `%EMAILLOCALPART%` / `%EMAILDOMAIN%` substituted, a redirect followed only within the domain; `guess` — `imap.<domain>` / `smtp.<domain>`, `known: false`. `needs_username` is set for an iCloud+ custom domain (sign-in is the @icloud.com address) and when autoconfig names a sign-in other than the address, given in `username`. Every network call goes to the user's own domain — its DNS and its web server, 3 s each; no third-party directory (Mozilla's ISPDB included) is asked. A preset domain makes no network call at all.
- `POST /v1/mail/accounts` — `{name, email, username, imap_*, smtp_*, password}`; IMAP and SMTP are tried first and a refusal is `422` with nothing stored. A sign-in name the server refuses is retried with the address and, on iCloud, the part before the @ (SMTP: the @icloud.com form) — at most three names, only on a credentials refusal, never on `NO [UNAVAILABLE]`, which Dovecot (Spacemail and many hosts) sends for a wrong password on a real mailbox and while it locks sign-in after failures; the name that worked is stored. iCloud and Gmail refusals carry what to do (an app-specific password); an `UNAVAILABLE` refusal says the password was not accepted. `PUT /v1/mail/accounts/{id}` edits (a new password is optional; refused with `400` on an OAuth account, whose `auth` only a new sign-in changes), `DELETE` removes the account, its mail and its password or refresh token, and answers `{ok: true}`; for an OAuth account it then revokes the refresh token at the provider (Google: `POST https://oauth2.googleapis.com/revoke`, RFC 7009, at most 5 s, best effort; Microsoft has no such endpoint for apps, so nothing is sent) and adds `revoked: bool` — whether the provider confirmed it. The account is gone either way. Every account carries `auth`: `password` (the default), `oauth2:google` or `oauth2:microsoft`. An OAuth account signs in with SASL XOAUTH2 using an access token refreshed from the stored refresh token and cached in memory until a minute before it expires (a rotated refresh token is saved back); a refresh token the provider refuses (`invalid_grant`), or a token the server refuses, is a sync error that says to sign in again.
- `GET /v1/mail/oauth/providers` — `{google: bool, microsoft: bool}`: which *Sign in with …* buttons work in this build (a provider without a client ID is `false`; see [docs/mail-oauth.md](../docs/mail-oauth.md)). Answers without opening Mail.
- `POST /v1/mail/oauth/start` — `{provider: "google" | "microsoft", login_hint?}` → `{auth_url, flow}`, the provider's page for the screen to open in the browser; `login_hint` (an address) is passed on so the provider's page starts on that account, and `flow` is an opaque id, not the state, for `GET /v1/mail/oauth/flow`. The authorization code flow with PKCE (S256); `state` and the verifier stay in memory, single use, for 10 minutes. The redirect is this daemon's own port on loopback: `http://127.0.0.1:<port>/v1/mail/oauth/callback` for Google, `http://localhost:<port>/…` for Microsoft (which ignores the port only for `localhost`). `409` when the provider has no client ID, `403` when the request did not reach the daemon by a loopback name (a paired phone: the browser could not come back).
- `GET /v1/mail/oauth/callback?code=&state=` — where the provider sends the browser. Exchanges the code (with the verifier), reads the address from the ID token, checks IMAP and SMTP with XOAUTH2, stores the refresh token in the secret store under the account's item, and creates the account — or switches an existing account with the same address to the sign-in, keeping its mail. Answers a small self-contained HTML page (*Connected — you can close this tab*, or the error); the screen sees the account through `GET /v1/mail/state`. It is the one `/v1` route admitted as a cross-site top-level GET (the browser arrives from the provider's page): only as `GET`, only on a loopback `Host`; the single-use `state` is its CSRF protection. Unknown, used or expired state is `400`. How the sign-in ended is recorded under its flow id.
- `GET /v1/mail/oauth/flow?id=` — `{status: "pending" | "ok" | "error" | "expired", email?, error?}`: how the sign-in started with that flow id is going. `pending` while the browser has not come back; `ok` with the address that was connected (the one the user signed in with, which may differ from the hint); `error` with the sentence the callback page showed; `expired` (with a sentence) for a flow that was never finished within 10 minutes, or an unknown id. Outcomes are kept in memory for 10 minutes. The import screen polls it every 1.5 s while a sign-in is out.
- `POST /v1/mail/import/grant` — macOS only (404 elsewhere): opens System Settings' Full Disk Access list (`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`) and reveals the daemon's executable in Finder, on the user's click; answers `{program}`. Nothing is read or sent.
- `GET /v1/mail/import` — the accounts the user already has in another client, so Mail can offer to add them instead of retyping: `{sources: [{kind, label, accounts: [Account], needs_permission?, error?, last_used?}], accounts: [Found], oauth: {google, microsoft}}`. `Account` is `{name, email, username, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, has_password, provider?, last_used?}`; `last_used` (unix ms) is when the mail app last wrote the profile the account came from — Thunderbird's `prefs.js`, Apple Mail's `Accounts4.sqlite` — and a source's is the newest of its accounts'; `kind` is `thunderbird` or `apple_mail`; `provider` is `google`, `microsoft`, `icloud`, `yahoo` or `fastmail` by the IMAP host or the address's domain, absent for any other server. `accounts` is every source's accounts merged by address (case-insensitive), in scan order: `Found` is the `Account` plus `source` (the kind to import it from — the one holding a saved password when any does), `from` (every kind that has it) and `signin`, the one step left: `ready` (its password came with it), `oauth` (Google or Microsoft with a client ID in this build), `app_password` (iCloud, Yahoo, Fastmail, and Google or Microsoft without one) or `password`. It reads only that client's own local files and opens nothing else (no `mail.db`, no engine). Passwords are never in the answer: Thunderbird's are decrypted locally (pure-Go NSS: PBKDF2-SHA256 + AES-256-CBC key wrap, 3DES or AES login blobs) and `has_password` is set, but the password stays in the daemon; Apple Mail passwords are not recoverable, so `has_password` is always false there. Apple Mail is read from `~/Library/Accounts/Accounts4.sqlite`: its IMAP accounts with their SMTP pair, and the Google, iCloud and Exchange accounts added in System Settings › Internet Accounts (`com.apple.account.Google`, `.AppleAccount` with its `.IMAPMail` child, `.Exchange`), which store no servers and get their provider's (Gmail; imap.mail.me.com; outlook.office365.com); an Apple Account whose address is not iCloud's and that has no mail child is skipped. `needs_permission: "full_disk_access"` is returned for Apple Mail when its account store cannot be read without Full Disk Access (the open fails with EPERM; macOS never prompts a launchd daemon for it), with `error` saying so in plain words and `program`, the daemon's own executable with symlinks resolved — the file to allow; the screen shows that one source as a box with the way to grant it, never one with another error and no accounts. Outlook for Mac is not read: its profile sits in another app's group container, which macOS 14 and later guard with an OS prompt Caprock does not raise. `CAPROCK_MAIL_IMPORT_HOME` replaces the home directory scanned, for preview daemons on fake profiles (the directory service answers the real home whatever `$HOME` says).
- `POST /v1/mail/import` — `{source, emails: [...], passwords?: {email: password}}`; adds the chosen accounts one at a time, exactly like `POST /v1/mail/accounts` (IMAP and SMTP verified first, nothing stored on refusal, password in the keychain). Each password comes from `passwords` when given (the retry after a saved one was refused), else from the source (decrypted locally, re-read fresh — it never crossed HTTP). An address Mail already has is not added twice: `ok` with `already: true`. Answers `{results: [{email, ok, error?, already?}]}`; one account failing never stops the rest. The import screen sends one address per call.
- `GET /v1/mail/messages?view=&account=&folder=&q=&before=&before_id=&limit=&junk=` — newest first, without bodies. `view`: `inbox unread flagged sent drafts archive junk trash folder all`; `q` is a full-text query (every word a prefix) over subject, people and body. Every row carries the junk filter's verdict: `junk` (bool), `junk_score` (0–100, 50 is the threshold) and `junk_why` (comma-separated rule codes, strongest first, omitted when empty). `junk`: empty leaves flagged mail out of `inbox`, `unread` and `all` without `q` (it shows in every other view and in search), `include` keeps it, `only` lists nothing else. `cat` narrows to conversations the AI triage labelled `important`, `updates` or `newsletter`; `spam` is the union — the filter's catch or the AI's label (the screen lists the filter's first) — and `nospam` everything else (the inbox's All); anything else is ignored. Each row carries `ai: {category, reply?, summary?, model?, user?, at}` when its conversation has a label. The Spam view asks `view=inbox&cat=spam` beside `view=junk`.
- `GET /v1/mail/messages/{id}` — one message with `body_text` and `body_html` (cleaned), fetched from the server if the background pass has not yet. `GET .../thread` — the conversation, oldest first. `GET .../part/{path}` — one attachment or inline image by IMAP part path or `cid:<id>`; `?download=1` forces an attachment disposition; served with a sandboxing CSP.
- `POST /v1/mail/cleanup/preview` — `{view: "junk"|"trash", account: 0|id, before: 0|unix_ms, min_score: 0..100}` returns `{ids: number[], identities: {[id]: string}}` for all matching synced messages, independent of list pagination. Spam includes server Junk plus locally flagged or AI-labelled spam in Inbox. A nonzero cutoff uses message date strictly before it, excluding unknown dates; a nonzero score requires a local junk verdict at or above that score (not a calibrated probability).
- `POST /v1/mail/cleanup` — the same query plus the reviewed `ids` and `identities` snapshot. Identities bind each local ID to its account, folder, UIDVALIDITY and UID so reused SQLite IDs cannot select new mail. Rechecks eligibility and intersects with the snapshot, excluding newly arrived or restored mail. Spam moves to Trash, requiring MOVE or UIDPLUS to avoid broad-expunge fallbacks; Trash permanently deletes only the selected UIDs, refusing servers without UIDPLUS or IMAP4rev2 before setting deletion flags. Processes up to 200 IDs per batch. Returns `{ok:true}`, `400` for invalid scope or missing snapshot, or `502` on an operation failure; earlier batches may already have completed, so refresh before retrying.
- `POST /v1/mail/actions` — `{ids, action, folder}`; `action`: `read unread flag unflag archive trash spam inbox move notjunk`. Archive goes to the Archive folder, else Gmail's All Mail, else a new `Archive`; trash on a message already in Trash deletes it. `notjunk` is *Not spam*: a message in a Junk folder moves to the inbox (as `inbox`), one the junk filter hid stays put with `junk` cleared (`junk_why: you-said-not-junk`); either way the classifier learns it as ham, the sender goes on the allow list (which also clears its other hidden mail), and the AI triage hears it too: a conversation it labelled `spam` takes the user's label `important`, and the sender is added to `triage_senders` so the model's later spam for them is replaced — one action clears spam from both sources, and the screen's *Not spam* (`n`) sends only this. `spam` on mail outside the Junk folder is learned as spam, takes the sender off the allow list and labels the conversation `spam` for the triage (removing the sender from `triage_senders`); `inbox` on mail in the Junk folder is learned as ham and allows the sender, like `notjunk`.
- **Junk filter** (`internal/mail/spam`, run by `internal/mail/engine/junk.go`). Local only: no AI, no network, on by default, and it never moves or deletes anything on the server — the verdict only hides inbox mail. Inbox mail is judged when its header lands (so junk never shows while its body is fetched) and again with its body; inbox mail stored before the filter existed has `BODY.PEEK[HEADER]` read again, newest first, 300 messages per sync pass, and is judged then. Points, junk at 5: the receiving server's verdict — `X-Spam-Flag`/`X-Spam`/`X-Spam-Status: Yes`, an rspamd action or `X-Spamd-Result: default: True`, Microsoft SCL ≥ 5, a `[SPAM]` subject tag — +6, a provider score at or over its own `required` +5 (≥ 5 with no limit +4, ≥ 3 +1.5); only the topmost `Authentication-Results` counts (ARC's when there is none, `Received-SPF` for a missing SPF): DMARC fail +3.5, SPF fail +2.5, softfail +1, DKIM fail +1.5, neither SPF nor DKIM +1.5, SPF and DKIM pass −1.5, DMARC pass −1; a brand display name on an unrelated domain, or a display name holding another address, +4; Reply-To on a free mail domain from a non-free one +2, any other domain +0.5; a TLD from the most-abused list +1.5; `Re:` with no `In-Reply-To`/`References` +1.5; a shouting subject +1, `!!!`/`$$$` +1; no Message-ID +1; List-Unsubscribe with DKIM pass −1; a URL shortener +1.5, a link showing a brand's domain and going elsewhere +2.5, image-only (< 120 visible characters) +2, link-only (< 60) +1.5. Once the server called it spam no negative point counts. The classifier — Robinson naive Bayes with Fisher combining over subject words, sender name words and domain, Reply-To domain, link hosts, auth results and the first 20 KB of text, at most 400 distinct tokens a message — adds (p − 0.5) × 11 clamped to [−4, +5], once it has learned 10 messages of each kind. It is global, not per account. It learns the server's Junk folder as spam and the Sent folder plus inbox mail the user replied to, starred or got from a correspondent as ham, at most 2,000 of each automatically (read mail alone is never ham), and every user Spam / Not spam without a cap; a lesson the user changes moves its tokens across, and an automatic lesson never overrides the user's. Its table is pruned to the most-seen tokens past 60,000. When it first becomes ready, the newest 2,000 inbox messages are judged again from stored facts. Never junk, whatever the points: an address the user wrote to (`contacts.sent`), allowed with Not spam, or one of the user's accounts; a thread holding the user's own sent mail; a message the user answered or starred. New Sent mail clears the verdict from inbox mail of those recipients.
- `POST /v1/mail/send` — `{account_id, to, cc, bcc, subject, text, in_reply_to, attachments: [{filename, type, data(base64)}]}`, up to 40 MB. Filed in Sent (Gmail files it itself); the answered message gets `\Answered`.
- `POST /v1/mail/sync?account=` — sync now. `GET /v1/mail/contacts?q=` — address completion.
- `GET|PUT /v1/mail/settings` — `ai_enabled` (`"0"`), `ai_provider` (`""`, automatic; else `claude`, `codex`, `gemini`, `anthropic`, `openai`, `openrouter`, `deepseek` or `local`), `ai_url` (`http://127.0.0.1:11434/v1`, the local server), `ai_model` (the local server's model, `""` its first), `ai_model_<provider>` for every other provider (`""` is the CLI's own default, `claude-haiku-5-5` for `anthropic`, `deepseek-chat` for `deepseek`; `openai` and `openrouter` need one), `remote_images` (`ask` or `always`). `ai_language` (`auto`, the email's own language; else `en`, `ru`, `es` or `de` — anything else is stored as `auto`) is the language summaries and triage one-liners are written in; a drafted reply keeps the thread's language. Changing any `ai_*` setting starts a sorting run with past failures forgotten. API keys are never settings.
- `GET /v1/mail/ai/status` — `{chosen, provider, label, sends_to, available, error?, models, providers: [{id, label, kind, command?, default_model?, needs_model?, model_hint?, sends_to, available, why?, model, key_set?, key_where?}]}`. `chosen` is the saved `ai_provider`; `provider` the one in use — the saved one, or with `chosen` empty the first available of `claude` → `codex` → `gemini` → `local` (`""` and an `error` when none is). `kind` is `cli` (available when `agents.FindBinary` finds the command; Claude Code's is the spawn manager's), `api` (available with a stored key, and a model where `needs_model`) or `local` (available when its `/models` answers, 3 s at most; `models` lists them when it is the one in use). `sends_to` says where the mail text goes for that provider. `model` is the model in use (`""` for a CLI's own default). Before Mail is used it answers from the defaults without creating `mail.db`.
- `PUT /v1/mail/ai/key` — `{provider, key}` for an `api` provider (`400` for any other); `""` removes it. Stored through `internal/secret` (macOS login keychain item `dev.caprock.mail.ai.<provider>`, else a 0600 file `mail-ai-<provider>-key` in the data directory); in sample mode in memory only. Answers `{ok, key_set}`; no route ever returns a key.
- `POST /v1/mail/ai/summarize` and `POST /v1/mail/ai/draft` (`{message_id, instruction}`) → `{text, provider, label, model}` (who answered, which the reader names under the summary). The summary is written in `ai_language`. `409` while `ai_enabled` is off or no provider is available (before any mail is read), `502` when the provider fails, with its reason. The last eight messages of the thread go between two `BEGIN/END EMAIL DATA <nonce>` lines the system prompt names as data never to follow; the draft's instruction is outside them. A CLI gets everything on stdin and no tool: `claude -p --output-format json --tools "" --no-session-persistence --setting-sources local --settings <disableAllHooks file> [--model m] --system-prompt <s>`; `codex exec --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --sandbox read-only --color never -c web_search=disabled --disable <shell_tool, unified_exec, code_mode, code_mode_host, hooks, plugins, apps, multi_agent, multi_agent_v2, image_generation, view_image, browser_use, computer_use, skill_search, tool_suggest, goals, memories> [-m m] -o <file> -`; `gemini -p "Answer as instructed above." -o json --approval-mode plan --skip-trust -e none --allowed-mcp-server-names caprock-none [-m m]` with `GEMINI_CLI_SYSTEM_SETTINGS_PATH` naming a file that turns hooks, built-in tools (`tools.core: []`) and skills off. Each runs in the login shell's environment from `<data>/mail-ai`, 3 minutes at most. `anthropic` calls `POST https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`); `openai`, `openrouter`, `deepseek` and `local` call `<base>/chat/completions` (a bearer key for the cloud ones).
- **AI triage** (no route starts it). While `ai_enabled` is `"1"` and a provider is available, a background run sorts inbox conversations: after every finished sync pass and whenever an `ai_*` setting changes, it takes the newest 200 inbox conversations (by newest message) that have no label or have gained a message since (`messages.id` above the label's `message_id`) and no label of the user's — leaving out any conversation the junk filter caught, which never goes to an AI — and sends them 8 per call through the same provider, client and CLI flags as summarize. Each conversation is its newest three messages (sender, date, subject, stored text clipped to 600 characters, the snippet when no body is stored — no server call), between `BEGIN/END EMAIL DATA <nonce>` lines, as `c1…c8`; the model answers `{"items": [{id, category, reply, summary}]}`. The answer is untrusted: an id outside the batch, a duplicate or a category outside `important updates newsletter spam` is dropped (`reply` as a category folds into `important` with `reply: true`; `reply` is kept only for `important`), and the summary becomes one line of at most 140 characters. One run at a time; a failed call pauses sorting 2 minutes, doubling to 30, silently; a conversation answered for twice without a valid item waits for a restart. The run never moves, flags or deletes mail. The model's `spam` for a sender the user cleared becomes the user's label. In sample mode the sample inbox is labelled from a canned table by sender, with no call and whatever `ai_enabled` says (`model: "sample"`).
- `POST /v1/mail/triage/label` — `{message_id, category}`: the user's own label for that message's conversation (`user: true`, `model: "user"`), never overwritten by the model; a category other than `spam` also clears the message's sender for that account (`triage_senders`), so their later mail is not sorted as spam; `spam` removes the sender from it. `400` for a category outside the four, `404` for an unknown message. It touches only the AI's label; the screen's *Not spam* uses the `notjunk` action instead, which also clears the junk filter's flag and teaches it.

**`mail.db`** is not part of the event store's migration chain; its schema is
`internal/mail/mailstore/schema.sql`, applied idempotently at open: `accounts`
(servers, signature, last sync and error, `auth` — never the password or
token), `folders`
(name, role, `uidvalidity`, highest stored UID, counts), `messages` (envelope,
flags, thread key, snippet, decoded text and HTML bodies, the body structure
as JSON, and the junk filter's `junk`, `junk_score`, `junk_why` and
`junk_hdr` — the header facts as JSON, `''` until read), `messages_fts` (FTS5
over subject, people, body), `settings` (also the classifier's
`junk_learned_spam` / `junk_learned_ham` totals and the one-time
`junk_sent_backfill` flag), `contacts` (addresses seen, weighted towards ones
written to; `sent` counts the times the user wrote to it), `junk_tokens`
(token → spam and ham message counts, `WITHOUT ROWID`), `junk_trained`
(account, Message-ID or `uid:<folder>:<uid>`, spam or ham, `by_user`) and
`junk_allow` (addresses the user said *Not spam* for), `triage` (added
2026-10-15; one row per sorted conversation, primary key `(account_id,
thread_key)`: `message_id` — the newest message row the label saw,
`category`, `reply`, `summary`, `model` — `provider[/model]`, `user` or
`sample`, `user_set`, `at`; rows go with their account) and `triage_senders`
(`(account_id, addr)` → `category`: senders the user said are not spam,
address lowercased). New tables are added to an existing file by `CREATE
TABLE IF NOT EXISTS` itself. `CREATE TABLE IF NOT
EXISTS` does not change a table that exists, so a column added after a table
shipped is also listed in `addedColumns` (`store.go`), which adds it to an
existing file when `pragma_table_info` lacks it: `accounts.auth TEXT NOT NULL
DEFAULT 'password'`; `messages.junk INTEGER NOT NULL DEFAULT 0`,
`messages.junk_score INTEGER NOT NULL DEFAULT 0`, `messages.junk_why TEXT NOT
NULL DEFAULT ''`, `messages.junk_hdr TEXT NOT NULL DEFAULT ''` and
`contacts.sent INTEGER NOT NULL DEFAULT 0` (one block; on first open
`contacts.sent` is filled from the Sent mail already stored). No index names a
column added this way: `schema.sql` runs before `addedColumns`.

### Private modules (`/v1/admin`, `/x/<id>/`, `/v1/x/<id>/docs`)

The module slot ([ADR-076](08-decisions.md)). Code: `internal/modules` (key,
manifest, install), `internal/api/modules.go`, `internal/store/moduledocs.go`,
`cmd/caprock/module.go`, `ui/src/lib/modules.ts`, `ui/src/lib/modulebridge.ts`.
Every route is the machine's and a paired **controller's** (amended
2026-10-21): `GET /v1/admin`, `GET /x/<id>/…` and the document routes are
in the gate's controller list (`controllerRoutes`; `deviceMay` for `/x/`) and
each handler checks again (`moduleCaller`). A viewer gets `403` on all of
them, a device with no token `401` (`/x/` is not served to unpaired devices
as the dashboard's files are), and a request relayed onto loopback by a proxy
is a device, never the machine. `PUT` and `DELETE /v1/admin` are the
machine's alone (`403` from any device).

- **`GET /v1/admin`** → `{admin: false}` without a valid key (and to any
  caller that is neither the machine nor a controller); with one,
  `{admin: true, subject, modules: ["<id>", …], installed: [{id, name,
  version?, url: "/x/<id>/", attention?}]}` — `installed` lists only the
  modules that are installed and named in the key; `attention` is the
  module's current attention (below), absent at 0 or once it is a day old. A stored key that does not verify adds
  `key_error`, and nothing else.
- **`PUT /v1/admin`** `{key}` verifies the key and stores it trimmed as
  `config.json`'s `admin_key`; 400 with the reason when it does not verify;
  an empty key clears it. Answers as `GET`. **`DELETE /v1/admin`** clears it.
- **Key:** `CRA1.<payload>.<sig>`, `payload` base64url of `{"v":1,"sub",
  "role":"admin","modules":[…],"iat":"YYYY-MM-DD"}`, `sig` base64url of an
  Ed25519 signature over the ASCII `payload` part, verified with the raw
  public key `modules.PublicKey`. Padding is accepted and not required. A
  module id is `^[a-z][a-z0-9-]{0,31}$`.
- **`GET /x/<id>/<path>`** serves the installed module's files when the key
  names it; `/x/<id>` redirects to `/x/<id>/`; a folder is its `index.html`
  or 404, never a listing. Anything else is a plain 404.
- **Documents:** `GET /v1/x/<id>/docs/{collection}[?after=&limit=]` →
  `{docs: [{id, data, created_at, updated_at}], next?}` by id, 100 by default,
  at most 1000; `next` is the last id when the page is full. `GET|PUT|PATCH|DELETE
  /v1/x/<id>/docs/{collection}/{docId}`: `PUT` writes a JSON object whole
  (`created_at` kept), `PATCH` merges top-level fields into an existing one
  (null removes a field; 404 when absent), `DELETE` → `{deleted}`. Bodies are
  JSON objects of at most 1 MB. Collection and document ids are
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. 403 unless the key names `<id>`.
- **Telegram** (amended 2026-10-22, `internal/api/moduleout.go`,
  `internal/telegram/module.go`): **`POST /v1/x/<id>/telegram`** `{text,
  buttons?: [{id, label}], reply?}` → `{message_id}`: one message through the
  owner's own bot to the owner's own paired chat — never another chat, and
  never a second bot (the bridge is the bot's one `getUpdates` reader). The
  message is HTML: `🧩 <b><module name></b>`, a newline, then `text`
  escaped. `text` is 1–3500 characters; at most 12 buttons, one per row, `id`
  `^[A-Za-z0-9._-]{1,48}$` and unique, `label` 1–64 characters; `reply: true`
  opens the reply field under a message with no buttons. 403 unless the key
  names `<id>`; 400 for a bad message; 409 with no bot or paired chat, or
  under `/mute all`; 502 with Telegram's words. No licence and no alert
  switch is needed; it goes through the outbox at Telegram's pace. **Answers
  land in the module's store**, collection `telegram`, document
  `<message_id>-<n>` (`n` counts that message's answers from 1): a press of
  one of its buttons is `{button: "<id>", at: <ms>}`, after which the
  message's buttons become one `✓ <label>`; a text reply to it (the reply
  field, or a swipe-reply) is `{text, at}`, marked 👍, and never reaches a
  session. While such a message is less than a day old the bridge reads
  updates even with every alert and two-way chat off. An answer for a
  module the key no longer names is not kept; the button says *Not saved*.
  **`reply_to_message_id`** (optional) threads the new message under one
  this module sent; any other id (another module's, the bridge's own, an
  unknown or forgotten one) is `404` and nothing is sent; a negative one
  is `400`. **`pin: true`** pins the message once sent (below); when only
  the pin is refused the answer is `502` `{error, message_id}`, the message
  having been sent.
- **Editing a sent message** (amended 2026-10-22): **`PATCH
  /v1/x/<id>/telegram/<message_id>`** `{text?, buttons?, pin?}` →
  `{message_id}`. An omitted (or `null`) part is left as it is; `buttons:
  []` removes the keyboard; `pin: true` pins the message, `pin: false`
  unpins it; at least one part is required (`400` otherwise). Text and
  buttons are changed first, then the pin. A message can be edited any
  number of times. Same limits as
  `POST`: `text` 1–3500 characters (the first line still names the module),
  buttons as above. New text is `editMessageText` and keeps the keyboard the
  message shows (its buttons in their order, or the `✓ <label>` of a press);
  buttons alone are `editMessageReplyMarkup`. A press on new buttons is
  written to the store exactly like one on the first (`telegram/<message_id>-<n>`,
  `n` continuing); a press on a replaced button says *That button is out of
  date*. Telegram's *message is not modified* is a `200`. Only a message
  this module sent: any other — another module's, the bridge's own, an
  unknown, non-numeric or forgotten id — is `404` and nothing is sent. Which
  module sent a message is kept in `telegram.json` (§ Telegram bridge), so
  it outlives a restart; it holds the last 400 messages the bridge sent, and
  disconnecting the bot forgets them. `403` unless the key names `<id>`;
  `409` with no bot or paired chat; `502` with Telegram's words. `/mute all`
  does not hold an edit back: it changes a message already in the chat and
  makes no sound.
- **Pinning** (amended 2026-10-22): a module holds **at most one** pinned
  message. A pin is `pinChatMessage` with `disable_notification: true`;
  once it succeeds, the module's previous pin, if another message, is
  unpinned with `unpinChatMessage` and that `message_id` — never a pin the
  bridge, another module or the owner made. `pin: false` unpins only that
  message; Telegram saying it is not pinned counts as done. The module's
  pin is kept in `telegram.json` (`module_pins`), so it outlives a restart.
  A refused pin (the bot lacks the right to pin) is `502` with Telegram's
  words, the token never in them, and the previous pin stays.
- **Notification** (amended 2026-10-22): **`POST /v1/x/<id>/notify`**
  `{title, body?}` → `204`: a desktop notification from the Caprock app,
  titled `<module name> · <title>`, whose click opens `#/x/<id>` (§ Notify
  frame, kind `module`). `title` 1–120 characters, `body` at most 400; 400
  otherwise, 403 unless the key names `<id>`. `204` also when nothing is
  shown: both desktop notification switches off, or no desktop app open (a
  browser tab shows none). It stays in Notification Center like the app's
  other notifications.
- **Attention** (amended 2026-10-22, `internal/api/moduleattention.go`):
  **`PUT /v1/x/<id>/attention`** `{count, items?: [{label, href}]}` → `200`
  with what is kept, `{count, items, updated_at}` (ms), replacing what the
  module said before. `count` is an integer ≥ 0, and `count: 0` clears it
  (→ `{count: 0, items: []}`); at most 8 items; `label` 1–80 characters on
  one line, trimmed; `href` a route inside the module's own page — `#` and
  then 1–511 characters with no space or control character (`#review/42`),
  never a URL. Unknown fields, or a body that is not that object (16 KB at
  most), are `400`, like every refusal above; `403` unless the key names
  `<id>`; `404` when the module is not installed. It is kept in memory and in
  `module_docs` under the reserved collection `_attention`, document
  `current` (a collection id the document routes cannot name), so it
  survives a restart without a migration; it is shown while under a day old
  (24 h after the last `PUT`, it is as if cleared). Every `PUT` publishes an
  `admin` frame carrying `{}` (§ Live socket), on which the dashboard reads
  `GET /v1/admin` again. In the app's sidebar it is the module row's informer
  ([04-ui.md § Private modules](04-ui.md#private-modules)); an item opens
  `#/x/<id>?to=<href, encoded>`, the frame loading `/x/<id>/?theme=…<href>`
  on the machine and, on a phone, getting a `caprock:route` message
  `{type: "caprock:route", hash: "<href>"}` on load, which the bootstrap
  applies to `location.hash`.
- **Who may call them:** the machine and a controller, like the store
  (`controllerRoutes`); on a phone the module bridge forwards a `POST` of
  exactly `/v1/x/<id>/telegram` or `/v1/x/<id>/notify`, a `PATCH` of
  `/v1/x/<id>/telegram/<digits>`, and a `PUT` of exactly
  `/v1/x/<id>/attention`.
- **Install:** `caprock module install <dir>` (hidden) copies a folder with
  `module.json` (`{id, name, version?}`, name 1–40 characters) and
  `index.html` into `<data dir>/modules/<id>/`, whole, through a staging
  folder; links are refused; at most 5000 files and 256 MB. `caprock module
  list`, `caprock module remove <id>` (documents are kept). `caprock license
  set <CRA1 key>` stores the admin key; `caprock license clear --admin`
  clears it.
- **On a paired phone** (ADR-076 amended 2026-10-21) the dashboard does not
  frame `/x/<id>/`. It fetches the module's files itself and runs one document
  built from them in `<iframe sandbox="allow-scripts allow-forms allow-modals
  allow-popups allow-popups-to-escape-sandbox allow-downloads"
  allow="clipboard-write" srcdoc>` — never `allow-same-origin`, so the page's
  origin is opaque. The build: the module's `index.html`; every module-own
  `<link rel="stylesheet">` and `<script src>` inlined as a `data:` URL
  (a stylesheet's `url(…)` to a module file as a `data:` URL too; other
  `<link>`s of the module dropped); every ES module reached by a literal
  specifier starting `./`, `../` or `/` (`import … from`, `export … from`,
  `import '…'`, `import('…')`) rewritten to `caprock-module:/x/<id>/<path>`
  and mapped to its `data:` URL in an import map; the page's own `<base>`
  removed; `data-theme`, `color-scheme` and the `--color-*`/`--font-*` tokens
  on `<html>`; then, first in `<head>`, `<base href="caprock-module:/x/<id>/">`,
  the import map and the bootstrap. At most 500 files and 64 MB. The
  bootstrap: `fetch()` of a URL that resolves under the base, and every
  `<img src>` that does (in the markup or added later), goes to the dashboard
  as `{type: "caprock:bridge", secret, id, method, path, headers, body}` and
  comes back as `{type: "caprock:bridge-reply", secret, id, status,
  statusText, headers, body}` (or `{error}`, which rejects the fetch with
  `TypeError`); images are set as `data:` URLs; `<a href="#…">` sets
  `location.hash`, and a link to a module file does nothing; a
  `caprock:theme` message is applied to `<html>`. Other URLs are the
  browser's. The dashboard answers only a message from that frame carrying
  its secret, and forwards it only when the path is the module's own: `GET`
  or `HEAD` under `/x/<id>/`, or `GET`, `HEAD`, `PUT`, `PATCH`, `DELETE`
  on `/v1/x/<id>/docs/<collection>[/<doc>]` — with no dot, empty or encoded
  `.`/`/`/`\` segment — or `POST` of exactly `/v1/x/<id>/telegram` or
  `/v1/x/<id>/notify`, or `PATCH` of `/v1/x/<id>/telegram/<digits>`, or `PUT` of exactly `/v1/x/<id>/attention`. Anything else is answered `403` without a request. It
  passes on `Content-Type` and `Accept` only, adds the device token, and says
  `application/json` on a write that did not; the reply carries the answer's
  `Content-Type`.
- **What a module must do to work on a phone:** reach its files by relative
  URLs or paths under `/x/<id>/`, its store by `/v1/x/<id>/docs/…`, and
  nothing else of the API; import its own modules with literal specifiers;
  read the theme from `<html data-theme>` or the `caprock:theme` message, not
  `?theme=` (the page's URL is `about:srcdoc`); expect `localStorage` and
  `window.top` to throw, `import.meta.url` to be a `data:` URL, and
  `history.pushState` to another path or query to be refused. Hash links (`#tab`) work as on the
  machine.

### GitHub

Connect GitHub, pick a repository to clone, put a local project on GitHub,
open a pull request from a worktree and follow its checks and reviews (WP-19,
F14; [ADR-039](08-decisions.md#adr-039--github-the-daemon-talks-to-the-api-with-the-gh-login-a-pasted-token-or-a-device-flow-token-that-never-leaves-it)).
Code: `internal/github`, `internal/api/github.go`,
`internal/daemon/github.go`, `ui/src/lib/github.ts`. The daemon is the only
thing that talks to GitHub; **no response, frame or log line carries the
token**.

```
GET    /v1/github                          → Status
PATCH  /v1/github          {notify}        → Status
DELETE /v1/github                          → Status (disconnected)
POST   /v1/github/connect  {source: "gh"} | {source: "token", token} → Status
POST   /v1/github/device                   → {device: Device}
GET    /v1/github/device                   → {device: Device | null}
DELETE /v1/github/device                   → {device: null}
GET    /v1/github/owners                   → {owners: [{login, avatar_url?, org}]}
GET    /v1/github/repos?owner=&q=&page=    → RepoPage
GET    /v1/github/prs                      → {prs: [PR]}
GET    /v1/github/actions-usage?owner=     → ActionsUsage (§ Runner cost, under Phase 1 additions)
GET    /v1/github/statuspage               → GitHubStatusPage (409 not_connected while GitHub is not connected)
GET    /v1/projects/{id}/github[?worktree=]          → WorktreeInfo
POST   /v1/projects/{id}/github/refresh[?worktree=]  → WorktreeInfo (read now)
GET    /v1/projects/{id}/github/items[?q=]           → Items (open issues and pull requests)
POST   /v1/projects/{id}/github/pr[?worktree=]  {title, body, base?, draft} → {pr: PR, pushed, push?}
POST   /v1/projects/{id}/github/repo  {name, owner?, private?, description?, protocol?, push?} → CreateRepoResult
```

- **`GitHubStatusPage`** — `{indicator, description, components, incidents,
  at, error?}`, the same shape and the same read as `status` in `GET
  /v1/repos/ci` (`github.StatusPage`, kept 5 minutes, sent no token, cookie
  or anything about the user). Every paired device may ask; nothing is sent
  while GitHub is not connected.
- **`Status`** — `{connected, source?, user?: {login, name?, avatar_url?,
  html_url?}, scopes, scopes_known, token_kind?, checked_at?, sources: {gh,
  stored, store, store_note?, oauth, client?}, health: {last_ok_at?, error?:
  Error, rate?: {resource, limit, remaining, reset_at, used}, paused_until?},
  device?, notify, tracked}`. `source` is `gh`, `token` or `oauth` (stored
  in `config.json` as `github_source`). `scopes` come from `X-OAuth-Scopes`;
  a fine-grained token has none (`scopes_known` false, `token_kind`
  `fine-grained`). `token_kind` is read from the token's prefix, never its
  value. `sources.gh` says the GitHub CLI is installed; `store` is
  `keychain` or `file`, and `store_note` says why a token is in the file on
  macOS. `sources.oauth` is true when `github_client_id` is set. The
  account is re-read every 10 minutes while connected.
- **Connect** validates with `GET /user` before anything is kept: `gh` runs
  `gh auth token --hostname github.com` (never stored; a stored token is
  removed), `token` stores the pasted value (one line, ≤ 255 characters).
  A refused token is the error and nothing changes. **Disconnect** removes
  only what Caprock stored and clears `github_source`.
- **Device flow** (only with `github_client_id`; otherwise `409 disabled`):
  `POST` asks `github.com/login/device/code` for scopes `repo read:org` and
  answers `{state: "pending", user_code, verification_uri, expires_at,
  interval}`; the daemon polls `…/login/oauth/access_token` itself
  (honouring `slow_down`) and the state becomes `done` (stored as source
  `oauth`, an `account` frame follows), `denied`, `expired` or `error`.
- **`RepoPage`** — `{repos: [RepoInfo], page, next, search?}`; `RepoInfo` is
  `{full_name, name, owner, private, fork, archived, description?,
  clone_url, ssh_url, html_url, default_branch?, pushed_at?}`. No `owner`
  and no `q`: `/user/repos` (owner, collaborator, organization member),
  recently pushed first; an `owner`: that account's or organization's;
  `q`: the search API, limited to `user:` and `org:` of your owners
  (`in:name fork:true`). 30 a page.
- **`PR`** — `{project_id, worktree, branch, repo, number, url, title,
  state: open|closed|merged, draft, base, head_sha, mergeable: bool|null,
  mergeable_state?, auto_merge?, created_at?, merged_at?, additions?, deletions?,
  changed_files?, commits?, review: approved|changes_requested|review_required|
  commented|"", reviews: [{user, state, at?}], checks: {state:
  pass|fail|pending|"", passed, failed, pending, items: [{name, state, url?,
  status?, started_at?, completed_at?, job_id?}]}, at, error?}`. Checks
  merge check runs and commit statuses on the head; a check run carries its
  own `status` (`queued | in_progress | completed`), its times (unix ms) and,
  when its link is a GitHub Actions job's (`…/actions/runs/{run}/job/{job}`),
  that `job_id` — the deck's mini pipeline draws them;
  `mergeable` null is GitHub still computing it; `auto_merge` is true while
  GitHub's auto-merge is enabled (its pull request object's `auto_merge`
  not null, read with the rest, no call of its own). `created_at` and
  `merged_at` are GitHub's stamps (unix ms); `additions`, `deletions`,
  `changed_files` and `commits` are the diff's size from the same answer for
  the one pull request (a list leaves them out, so they are absent there).
  Only pull requests whose
  head is in the same repository as `origin` are followed.
- **`WorktreeInfo`** — `{connected, repo: {owner, name, full_name, html_url}
  | null, reason?, branch, base, remote?, published, ahead, pr: PR | null,
  draft?: {title, body, commits}, primed}`. `repo` is null when `origin` is
  not on github.com (`reason` says so). `draft` prefills a new pull request:
  the title from the only commit's subject, else the branch name
  (`feat/github-auth` → `feat: github auth`); with more than one commit the
  body lists their subjects since `base`, oldest first (at most 50).
- **`Items`** — `{connected, repo: {owner, name, full_name, html_url} |
  null, reason?: no_remote|not_github, items: [Item], more, search?, at}`;
  `Item` is `{number, title, url, author?, labels: [{name, color?}], pr,
  draft?, body?, comments, updated_at?}`, `pr` true for a pull request (the
  issues API lists both). For New agent's *From GitHub*, read only when the
  picker opens, never polled. The repository is the main checkout's remote,
  as `WorktreeInfo` reads it; not connected, or not on github.com, answers
  200 with no items and asks GitHub nothing. No `q`: `GET
  /repos/{o}/{r}/issues?state=open&sort=updated&per_page=100`, `more` when
  a next page exists. `q` of a number (`123`, `#123`): `GET
  /repos/{o}/{r}/issues/123`, listed only if open (a 404 is an empty list).
  Other `q` (at most 200 characters, else `400 invalid`): the search API,
  `<q> repo:{o}/{r} is:open`, 50, `more` when the total is larger. `body` is
  cut to 8,000 characters. Each answer is kept in memory for **60 s** per
  repository and `q` (and dropped on disconnect), so reopening the picker
  asks nothing.
- **Open a pull request** pushes first when the branch is not `published`
  or is `ahead` (the Changes push: `projects.Service.Push`, the user's git
  credentials; a failed push answers as the push does and nothing is sent
  to GitHub), then `POST /repos/{o}/{r}/pulls` with head = the branch, base
  = `base` or the default branch. One already open is `409 exists` with
  `pr`.
- **Create a repository** refuses a project that already has a remote
  (`409 state`), creates it (`private` unless `private: false`) under the
  account or `owner` (an organization), adds `origin` (`https`, or `ssh`
  with `protocol: "ssh"`) and pushes the current branch unless `push:
  false`. A failed push still answers 200 with `push_error: {error, kind,
  output?}`; a failed `git remote add` is `422` with the created `repo`.
- **Failures** are `{error, kind, doing, message, github_status?, retry_at?,
  needs?, pr?}`, `error` the whole sentence the interface shows. Kinds and
  status: `not_connected`, `state`, `disabled`, `exists` → `409`;
  `rate_limit` → `429` with `Retry-After`; `invalid` → `400` when Caprock
  refused before asking GitHub; `auth` (401), `scope` (403 or 404 naming
  the missing scope or fine-grained permission in `needs`), `forbidden`,
  `not_found`, `invalid` (422), `network`, `github` (5xx) → `502` with
  GitHub's status. The last one is also `health.error`.
- **Polling.** The followed set is every worktree (and main checkout) of a
  listed repository project whose `origin` is on github.com and whose branch
  is not the default; it is re-read from the projects list every 15 s. A
  repository is polled (open pulls, then each followed one's pull, check
  runs, status and reviews) at most every **60 s**, doubling to **8
  minutes** while nothing changes; every `GET` is conditional on its last
  `ETag` (a `304` costs no rate limit); a rate limit pauses that resource
  until `Retry-After` or `X-RateLimit-Reset` (a minute when neither). A push
  through Changes or a refresh asks for a read (at most every 10 s).
  Nothing is sent while not connected.
- **Live.** `{type: "github", data: {kind: "pr", pr}}` when a followed pull
  request changes, `{kind: "pr_gone", project_id, worktree}` when it closes
  out of the set, `{kind: "account", account: Status}` when the account or
  its health changes. While `github_notify` (on unless turned off) holds,
  a check turning to `fail` or a new `approved` / `changes_requested` review
  is a `notify` frame of kind `ci` or `review` (§ Notify frame) with an
  empty `session_id`; never on the first read of a pull request.
- **Who.** The `GET`s (`…/github/items` included) are every paired device's; `…/github/pr` and
  `…/github/refresh` a controller's (ADR-034 amended); connect, device,
  disconnect, `PATCH` and `…/github/repo` the machine's only.
- **Where it talks to** (rule 4, [ADR-047](08-decisions.md)). The token goes
  only to `api.github.com` (a failed job's log comes from the signed address
  GitHub points to, without it). Two more destinations, only while GitHub is
  connected and only for what is on screen, neither sent the token or
  anything about the user: `www.githubstatus.com`'s public summary, by the
  daemon while Now's CI/CD section is open (§ `GET /v1/repos/ci`, kept 5
  minutes), and through `GET /v1/github/statuspage` — the same read, the
  same keep — which the dashboard asks only after a GitHub read failed on
  the network or with a 5xx, or every 5 minutes while the viewer has ticked
  *Watch GitHub Status* ([ADR-066](08-decisions.md)); and `avatars.githubusercontent.com`, the pull request authors'
  pictures GitHub named, loaded by the page itself (no referrer) on the PRs
  & CI Board and the CI/CD section — any other address draws initials.
  Settings → GitHub says so.
- **Where the token lives.** The GitHub CLI's: nowhere in Caprock. A pasted
  or device-flow token: on macOS the login keychain (service
  `dev.caprock.github`, account `caprock`) through `/usr/bin/security`,
  always with the keychain file named (`<home>/Library/Keychains/login.keychain-db`,
  home from Directory Services); a missing keychain file or a failing
  `security` puts it in `<data_dir>/github-token` (`0600`) with
  `store_note`. Elsewhere that file. `CAPROCK_SECRET_STORE=file` forces the
  file.
- **Test-only environment.** `CAPROCK_TEST_GITHUB_API` and
  `CAPROCK_TEST_GITHUB_WEB` replace `https://api.github.com` and
  `https://github.com`, honoured only for a loopback `http(s)` address;
  `CAPROCK_TEST_GH` names the `gh` binary while the API override is set.

### Projects DDL (migration 0041)

```sql
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  root           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo','folder')),
  source         TEXT    NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','session','folder','new','clone')),
  remote_url     TEXT    NOT NULL DEFAULT '',
  default_branch TEXT    NOT NULL DEFAULT '',
  added_at       INTEGER NOT NULL,             -- unix ms
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  sort           INTEGER NOT NULL DEFAULT 0,
  defaults       TEXT    NOT NULL DEFAULT '{}', -- JSON: {agent?, model?, permission_mode?, system_prompt?, setup_command?}
  archived_at    INTEGER                       -- unix ms; NULL = listed
);
```

`root` is normalised like `sessions.repo_root` (forward slashes, no trailing
separator), so the two join on equality. Cost attribution still uses
`sessions.repo_root` and `sessions.project`: adding or unlisting a project
changes no total.

### Project repositories DDL (migration 0050)

```sql
CREATE TABLE IF NOT EXISTS project_repos (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT    NOT NULL,             -- normalised like sessions.repo_root
  added_at   INTEGER NOT NULL,             -- unix ms
  PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_project_repos_path ON project_repos(path);
```

A multi-repo project's members ([ADR-055](08-decisions.md)). The daemon keeps
a path in one project's rows at a time. A project of repositories picked one
by one ([ADR-077](08-decisions.md)) has its own root among its rows: it is a
repository project (`kind = 'repo'`) whose root is one of its members, so no
column, kind or migration was added for it. Unlisting the project keeps its rows,
so adding its folder again brings it back as it was; a split deletes them.

### Reclassifying the /clear events already recorded (migration 0021)

No DDL: one `UPDATE` correcting rows the old write path mislabelled. Until
v0.52.1 every `SessionEnd` whose reason left the session running was stored as
`context.compact`, so the dashboard narrated "compacting context" at sessions
that had merely been cleared. Fixing the writer did not reach the rows already
stored, and on the owner's database **all 18 of them were the last event of
their session** — which is the phrase the session card shows.

The rewrite reads rather than guesses: `events.payload` keeps every field but
the bounded tool fields as Claude Code sent it, so
each row already names the hook that produced it. `hook_event_name = 'SessionEnd'`
is the whole condition, and `reason` picks the kind — `clear` → `context.clear`,
anything else → `session.continue`. A genuine `PreCompact` is untouched, which
is the row this could most easily destroy.

**It moves no figure.** The rewritten rows carry `cost_usd = 0` and no tokens
(cost comes from `turn.assistant`), verified on a copy of a real 665MB database
before and after — `13420.050393` both times, identical to the cent (rule 6).
Idempotent, so a kill mid-apply is safe to retry. Not reversible — the previous
`kind` is not kept — but recoverable from `payload`, which it does not touch.

Sessions left `active` by an old `/clear` are deliberately **not** closed here:
retiring a session whose process is still running is the failure
[ADR-028](08-decisions.md#adr-028--a-session-ends-when-its-process-does) exists
to prevent, and such a row ages to `idle` on its own.

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

### Payload compaction and auto-vacuum (no migration)

Two changes to stored state that no migration can make: a migration runs in a
transaction, and VACUUM cannot; and rewriting every payload inside one would
hold the write lock for minutes on a large database. Both run in the daemon,
only while it is idle (nothing recorded, and no request that may write, for
30 minutes), and both are recorded in `meta` so they finish once
(`internal/store/compact.go`, `vacuum.go`, `internal/daemon/compact.go`).

- **Payload compaction.** Events stored before `event.CapToolField` still
  hold base64. `store.CompactPayloadsStep` replaces it with the same marker the
  write path writes (`[image image/png 512 KB not stored]`) through
  `event.StripBinary`, which changes nothing else: **text is not clipped**, no
  key or array element is dropped, and a payload with no base64 keeps its
  bytes. It is stricter than the write path about what counts — the string
  must be at least 256 bytes of the base64 alphabet — because it walks whole
  payloads of every kind and version. `tool_bytes` keeps the size the tool
  handed back. Each step reads 500 event ids outside any transaction, then
  rewrites the rows that changed and moves the cursor in one short write
  transaction, matching each row on the payload it read so a concurrent
  rewrite (an assistant turn's merged prose) wins; the daemon pauses 50 ms
  between steps and stops as soon as anything is recorded.
  - `meta.payload_compact_until` — the highest event id when the pass began;
    later rows were written capped and are never examined.
  - `meta.payload_compact_cursor` — the highest id examined, then `done`.
- **`auto_vacuum=INCREMENTAL`.** Every connection is opened with
  `_pragma=auto_vacuum(INCREMENTAL)` before `journal_mode(WAL)`: a new database
  takes the mode with its first table. An older database (mode NONE) takes it
  with one VACUUM, which the daemon runs after the compaction has finished,
  while idle, and only with the room for it: free disk of at least 2.2 × the
  used size (file minus free pages) on the data directory's volume and 1.1 ×
  on the temporary directory's. VACUUM copies the database to a temporary file
  and writes it back through the WAL, so both copies exist at the peak. It is
  limited to 10 minutes and interrupted by anything that wants to write (the
  recorder's `OnWrite`, any API request but GET, HEAD and OPTIONS); an
  interrupted VACUUM rolls back and changes nothing, and is tried again a day
  later. The WAL it leaves is checkpointed with `TRUNCATE` at once. From then
  on `PRAGMA incremental_vacuum(1024)` (4 MiB at a time, 50 ms apart) gives
  the freelist back whenever it passes 8 MiB on an idle tick.

Measured on a copy of the owner's database (2.2 GB, 484,842 events,
2026-10-13), with a concurrent writer committing every 20 ms throughout:

- **Compaction:** 4,181 rows rewritten, 750 MB of payload removed, 975 steps
  in 79 s; slowest step 312 ms. The writer made 3,612 commits, none failed,
  slowest 38 ms. A second pass changed nothing.
- **VACUUM:** 2,176 MB to 1,384 MB in 21 s; the WAL reached 1,392 MB before
  the checkpoint (72 ms); free disk fell by 2,777 MB at the peak — 1.94 × the
  1,430 MB in use, which is where the 2.2 × requirement comes from. A
  VACUUM interrupted 5 s in by a writer returned at once, the writer waited
  2 ms, and the database was unchanged.
- **Incremental:** 40 MB of freelist (20,000 events deleted) returned in 10
  steps, 272 ms, slowest step 40 ms.

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

Owned sessions are spawned as `claude --session-id <uuid> [--model …] [--permission-mode …]`, so hooks and the transcript arrive under the id Caprock generated; the spawn environment is the user's login-shell environment (`internal/userenv`, see [02-architecture.md § Components](02-architecture.md#components)) with inherited Claude Code session markers stripped (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, … — `agents.childEnv`) so the session is a normal top-level one, and `LANG` set to a UTF-8 locale when none of `LC_ALL`, `LC_CTYPE` or `LANG` is (`userenv.WithUTF8Locale`; not on Windows). Before spawning, Caprock pre-accepts Claude Code's folder-trust dialog for the session's cwd by setting `projects["<cwd>"].hasTrustDialogAccepted = true` in **`~/.claude.json`** (a second user-level Claude Code file, distinct from `settings.json`) — otherwise an interactive session blocks on the trust prompt, which `--dangerously-skip-permissions` does not suppress. The write is best-effort, atomic, and skipped if the folder is already trusted; an unparsable `~/.claude.json` is never modified. It goes through the **ordered-JSON codec**, preserving the user's key order and any integer beyond 2^53 — a `map[string]any` round-trip sorted the whole 200KB file alphabetically and truncated large integers through float64. Each grant Caprock makes is recorded in `<data_dir>/trust-grants.json`, so `caprock hooks uninstall` revokes exactly the folders Caprock trusted and never one the user accepted themselves; a folder already trusted when Caprock found it is never claimed. Spawning is unavailable (endpoints return 501) only when no agent's binary is found; Caprock then stays observe-only. Codex, OpenCode and Gemini get their own argv and are never written into `~/.claude.json` ([ADR-031](08-decisions.md)). The manager resolves `claude` via PATH then `~/.local/bin`, `~/.claude/local`, `~/bin`, Homebrew and `/usr/local/bin`. Control operations are refused for sessions Caprock did not spawn.

### Phase 2 additions

```
POST     /v1/hive                     {hive?, repo?} → {hive, repo}   turns the task runner on, no restart
GET      /v1/hive/starter             → {repo, checks[], default_budget_usd}   the Tasks templates' prefill
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

**`GET /v1/hive/starter` is what the Tasks templates prefill from.** `repo` is the checkout workers branch from — the one in force, or the suggestion while the runner is off (the same string as `repo` / `suggested_repo` in `/v1/status`). `checks[]` is `{command, kind, source}` for every check command that repository declares, found by `internal/projcheck` from its files alone — nothing is run: Makefile targets `check` (kind `all`), `test`, `lint`, `vet`, `typecheck`, `build`; package.json scripts `test` (not `npm init`'s always-failing placeholder), `lint`, `typecheck`/`type-check`/`tsc`, `build`, spelled for the package manager its lockfile names (npm, pnpm, yarn, bun); `go test`/`go vet`/`go build ./...` for a go.mod; `cargo test`/`cargo check` for a Cargo.toml; `pytest`, `ruff check .`, `mypy .` only when the Python project's own config names them. Project entry points come first, so a template asking for a kind takes the project's own command over the toolchain's stock one; duplicates are dropped; an empty list is an honest answer. `default_budget_usd` is `board.DefaultBudgetUSD`, the ceiling `POST /v1/tasks` applies when the request names no budget — the form shows it as the placeholder rather than inventing one. It answers with the runner off (it reads, it does not arm) and `501` only when the build has no task runner. Not on the paired-device allowlist: a paired device reads the board but does not write tasks.

**`GET /v1/status` reports the hive.** `hive` and `repo` carry the queue directory in force and the checkout its workers operate on; both are omitted when orchestration is off. Which hive a running daemon had been started with was previously reported nowhere — not in `/v1/status`, not in `caprock status`, not in the startup line or the log — so there was no way to ask a live daemon what it was orchestrating. While it is **off**, `suggested_hive` (`~/caprock-tasks`) and `suggested_repo` (the daemon's cwd) carry what `POST /v1/hive` would use with no body — the defaults the dashboard names in its confirmation before turning anything on. Both are suggestions, not state: nothing is created until the POST.

**`POST /v1/tasks` validates before it writes.** A title is required (trimmed, at most 500 characters), the body is capped at 100 KB, and `budget_usd` must be finite, non-negative, and at most 100,000. Each of these was accepted before and produced a task nobody could use: an unnamed row on the board, a hundred-thousand-character title rendered into the task file, a negative budget that breaks every "is there budget left" comparison, and `1e308`, which overflows the moment anything is added to it.

**`done_criteria` is required.** At least one non-blank command; blank entries are trimmed away first. An empty list used to pass verification unconditionally ("trust the worker"), which made the product's central claim — nothing reaches `done` until its `done_criteria` pass — false for the easiest task to create. A task that nevertheless reaches verification with no criteria (hand-written into the hive, or created before this rule) escalates to `needs_you`; it never passes. See [05-orchestration.md § Verification runner](05-orchestration.md).

**`budget_usd` is enforced, not decorative, and never defaults to unlimited.** The reconciler tick re-attributes each live task's cost and, when spend passes the budget, **kills the worker session** before moving the task to `needs_you`, with the reason appended to the task body (no column, no DDL — the body is already returned by `GET /v1/tasks/{id}` and rendered by the UI). Parking the file alone left the process spending. `0` or absent on create becomes `board.DefaultBudgetUSD` ($5): an unattended session with no ceiling was the unsafe default. `budget_usd: 0` in a hand-authored hive task file still means no limit — Caprock does not rewrite a user's file. See [05-orchestration.md § Approvals](05-orchestration.md).

**`POST /v1/orchestrator/stop` is the emergency stop.** One call kills the orchestrator and every worker it spawned, and latches the router so it does not respawn them on the next tick; `start` clears the latch. It stops processes and leaves task files untouched. `POST /v1/agents/{id}/signal` remains the per-agent control — it takes `{"action": "pause"|"resume"|"kill"|"end"}`, and its 400 names that field, not only the accepted values. `end` is what closing a tab sends: it asks the process to stop (SIGTERM, resumed first if paused) so Claude Code writes its transcript out and the session can be continued with `--resume`, and kills it only if it is still running five seconds later; `kill` is immediate.

**`POST /v1/tasks/{id}/verify` never strands a task.** Verification walks a legal status route rather than skipping a transition it cannot make in one hop, so a verify from any non-`verifying` status still lands the task in `done`, `in_progress` or `needs_you`. Guarding a single hop and no-opping when illegal used to leave the task where it was, after which the next verify failed with `illegal task transition`.

**Task ids carry a per-process sequence** (`t-<unix-ms>-<n>`). The millisecond alone collided: twelve concurrent creates produced four tasks and eight "already exists" rejections, so a user adding several at once silently lost most of them.

Live frames gained `mail.*` events (router) in Phase 2.


**`GET /v1/stats/summary` takes `?agent=`** — `claude`, `opencode`, `gemini`,
`codex`, `deepseek`, `grok`, `hermes`, or omitted for every agent. With no filter or
`hermes`, the summary carries **`hermes`** when the range has Hermes turns
(`store.HermesCost`, [ADR-069](08-decisions.md)): `{total_usd, actual_usd,
estimated_usd, included_turns?, unpriced_turns?, background_usd,
sources?: [{source, cost_usd}]}` — Hermes's own figures by `cost_basis`, and
the background part by `hermes_source`, largest first; all of it already
inside `cost_usd`. An unrecognised value is a **400**: returning every agent's spend
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
  tool_bytes  INTEGER NOT NULL DEFAULT 0,    -- bytes the tool returned, before the payload cap (0018)
  internal    INTEGER NOT NULL DEFAULT 0,    -- 1 = hidden product machinery (0024)
  inner_tool  TEXT                           -- tool a Codex `exec` script ran (0038)
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

- **Agents Caprock only observes** (`opencode`, `codex`, `deepseek`, `hermes`; one Caprock started is judged by its process) are judged by the clock alone. A Hermes session also ends when Hermes writes its `ended_at`.
  Their rows are read out of another tool's database, arrive months old, and
  have no process of ours to ask about.
- **Sessions with no pid** — written by an older shim, or read from a transcript
  with no live process behind them — fall back to a 24-hour staleness sweep,
  because there is nothing to verify and the only cost of being slow is a stale
  row. One fact is checked first: when such a session's transcript file (only
  when `has_transcript`, so the file was read and existed) or its `cwd` no
  longer exists, the next sweep ends it (2026-10-14: a test script wrote nine
  synthetic transcripts and deleted them, and the nine sessions read from them
  would otherwise have stayed listed as working for 24 hours). Only "does not
  exist" counts; a permission error ends nothing. There is no end-reason
  column, so the row records the end as any other sweep's.

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

**A database newer than the binary is refused, untouched** ([ADR-082](08-decisions.md)).
`meta.schema_version` is the only record of what was applied: the number of
the last migration, one transaction per migration. Before `store.Open` sets a
pragma, it reads that value through a separate `mode=ro` connection
(`store.CheckSchema`); when it is higher than the highest migration embedded
in the binary, the open fails with `store.SchemaTooNewError` and nothing is
migrated, written, backfilled or deleted — the file stays byte for byte as it
was (SQLite may leave an empty `-wal` and its `-shm` index beside it, which
the newer Caprock reads as nothing). `migrate` checks again before its loop,
for an in-memory database and for a race past the first check. Equal opens
as before; older migrates up as before. The daemon returns the error
unwrapped, so it is the line `caprock up` (from the log), the desktop app's
*Caprock could not start* and `caprock doctor` (`database_newer`, § Footprint)
show:

```text
the database <path> is from a newer Caprock (schema 67; this Caprock knows up to 66): install the newer Caprock to open it — nothing was changed
```

So a migration may change the storage layout in ways an older binary cannot
read: no older binary that carries this check will open it.

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

### Session title DDL (migration 0025)

```sql
ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
```

The agent's own name for a session. Claude Code writes it into the transcript as
`{"type":"ai-title","aiTitle":…}` — repeatedly, last one wins — and it is the
name its `/resume` picker shows; OpenCode keeps a `title` per session, with the
placeholder `New session - <timestamp>` treated as no title. Written only with a
non-empty value, so an event that names nothing never erases a name. Rows
ingested before transcript parser v3 are filled once from the transcripts still
on disk (`ingest.BackfillTitles`). Codex titles come from its own thread
index (`$CODEX_HOME/state_<N>.sqlite`, default `~/.codex`, newest generation, read-only, re-read only
when it or its WAL changes): `threads.name` becomes `title`, and
`threads.first_user_message` becomes `prompt` — the first thing the user typed,
for an agent whose prompts never become events. The rollout transcript's own
user messages cannot serve: all 60 checked opened with injected AGENTS.md or
auto-review text. `prompt` is empty for every other agent, whose first prompt
is read from events.

### Session name DDL (migration 0052)

```sql
ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';
```

The user's own name for a session, set by `PUT /v1/sessions/{id}/name`
`{name}` from its tab or sidebar row ([21-app.md](21-app.md) § What the user
sees). The name is made one line (whitespace collapsed) and clipped to 120
characters; `""` clears it. It outranks `title` wherever a session is named
(`description_source: "name"`), and nothing the agent writes touches it, so a
later `ai-title` cannot undo a rename. Searching sessions matches it. `Session`
carries it as `name`, never omitted — a live `session` frame patches the
client's copy, and a frame without the key would leave a cleared name
standing. A rename publishes that frame, so every window shows it without a
refetch. A controller device may rename; a viewer may not.

### Chats DDL (migration 0059)

```sql
ALTER TABLE sessions ADD COLUMN chat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET chat = 1
WHERE cwd GLOB '*[/\]chats[/\][0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
   OR cwd GLOB '*[/\]chats[/\][0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*';
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(last_event_at) WHERE chat = 1;
```

`chat` marks a session as a chat ([ADR-071](08-decisions.md), § Chats);
`archived_at` is when it was archived, 0 while it is not. The backfill marks
every session already in a chat folder by its name, so chats from before the
column are chats. The partial index serves the Chats list; the work list's
`chat = 0` reads the table as before.

### AI;DR DDL (migration 0060)

```sql
CREATE TABLE IF NOT EXISTS event_tldr (
  event_id   INTEGER PRIMARY KEY,
  text       TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  cost_usd   REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

One kept AI;DR per assistant answer ([ADR-072](08-decisions.md), § AI;DR):
`event_id` is `events.id`, `model` and `cost_usd` what claude reported for
the call, `created_at` unix ms. A row goes with its event: removing a
session deletes its rows, and `PruneEventsBefore` deletes those whose event
is gone, because an event id is a rowid that may be handed out again.

### Module documents DDL (migration 0061)

```sql
CREATE TABLE IF NOT EXISTS module_docs (
  module     TEXT NOT NULL,
  collection TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (module, collection, doc_id)
) WITHOUT ROWID;
```

A private module's documents ([ADR-076](08-decisions.md), § Private modules):
`data` is a JSON object as text, which the store never reads into;
`created_at` and `updated_at` are unix ms. Rows stay when a module's files are
removed, so installing it again finds them.

### Subagent model (migration 0065)

```sql
ALTER TABLE sessions ADD COLUMN subagent_model TEXT NOT NULL DEFAULT '';
```

`POST /v1/agents` takes `subagent_model`: `haiku`, `sonnet` or `opus`, or
absent/empty for the session's own model; anything else (another string, a
non-string) is a 400 with nothing started. For a Claude Code session the
daemon sets `CLAUDE_CODE_SUBAGENT_MODEL=<value>` in the child's environment,
the variable Claude Code reads for its subagents' model (the binary lists it
with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; checked in 2.1.303 on 2026-10-19: the value is lower-cased and resolved by the same alias resolver as `--model`, so `haiku`, `sonnet` and `opus` map to the current full ids, and `inherit` or empty means the lead's model). Nothing
else from the request reaches the environment, no value is passed through, and
other agents ignore the field. Absent, the user's own environment is left as it
is. The choice is recorded once on the session row (`subagent_model`, in the
`Session` JSON as `subagent_model`, omitted when empty) for the session card.

### Idle end DDL (migration 0067)

```sql
ALTER TABLE sessions ADD COLUMN idle_ended_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN idle_ended_after INTEGER NOT NULL DEFAULT 0;
```

When Caprock ended the session because it sat idle with no tab (unix ms) and
the idle window that did it (ms); both 0 otherwise, and set back to 0 when
the session is started again. See § Ending idle sessions.

### Session generation DDL (migration 0063)

```sql
CREATE TABLE IF NOT EXISTS session_gen (
  session_id TEXT    NOT NULL PRIMARY KEY,
  gen        INTEGER NOT NULL
) WITHOUT ROWID;
-- events_gen_update, events_gen_delete: AFTER triggers on events that upsert
-- gen + 1 for NEW.session_id (update; OLD.session_id too when an update moves
-- a row) and for OLD.session_id (delete). No insert trigger.
```

A session's rewrite generation. `store.EventsGen` pairs it with the session's
newest event id, `MAX(id)` by `idx_events_session_id`, read in one statement:
the triggers move `gen` in the same transaction as every update or delete of
the session's events, whichever code writes them, and every insert raises the
newest id, because a new row takes a rowid above every existing one. Equal
pairs mean the session's events are unchanged. Inserts have no trigger because
any trigger on `events`, even one that does nothing, is compiled into every
statement that fires it and the driver prepares each statement afresh: a no-op
insert trigger took an insert from 58 to 129 µs (2026-10-18, temporary
on-disk database, 20,000 events in batches of 500).

`GET /v1/sessions` keys its per-session cache on the pair: the newest 60
events, the main thread's newest event and turn and the first prompts a summary
reads are read again only when it has moved; the session row, stats, live
subagents, loops, nudges and the clock are read on every request (F14,
`docs/resource-usage-audit-2026-10-18.md`). The pair is read before the
events, so a cached value is never older than its key. Rows are never deleted,
so a removed session id seen again carries on from its old generation instead
of reusing one. A migration that rebuilds the events table must recreate the
triggers; `TestEventsGenTriggersExist` fails otherwise.

### Worked-at and parent DDL (migration 0027)

```sql
ALTER TABLE sessions ADD COLUMN worked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN parent_session TEXT NOT NULL DEFAULT '';
```

- **`worked_at`** — unix ms of the session's last `turn.user`, `turn.assistant`,
  `tool.pre` or `tool.post`: the last time anyone worked in it. `last_event_at`
  also moves on `SessionEnd`, `/clear` and the pid sweep, so after a reboot
  every ended card read the moment of the reboot — four cards "ended 29 Sep
  18:26" that had been worked in hours apart (FB-037). Only grows. The
  migration fills it from events; 289 of 304 sessions on the owner's database,
  the rest have no work events.
- **`parent_session`** — the session this one continues, recorded only from a
  fact: a `/clear` (`SessionStart` with `source=clear` in the same process —
  the previous session on that pid, `store.PreviousOnPID`) or a fork Caprock
  started (`--resume <id> --fork-session`). Never inferred from the same
  folder or branch. Written once. The migration fills it from the same two
  facts in stored events and spawn commands (3 clears and 1 fork on the owner's
  database). A plain resume keeps its session id and needs no link.
- The sessions list orders an ended session by `worked_at` (falling back to
  `last_event_at`), so a reboot does not reshuffle history.

`SessionSummary` carries both as `worked_at` and `parent_session`, omitted when
unset, and `detached` (see `resume` above).

### Relay DDL (migration 0036)

```sql
ALTER TABLE sessions ADD COLUMN relay_from TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_relay_from
  ON sessions(relay_from) WHERE relay_from <> '';
```

The session whose work this one was started to carry on, with a brief rather
than its conversation ([ADR-032](08-decisions.md)); written by the daemon when
`POST /v1/agents` carries `relay_from`, after the spawn. Not
`parent_session`: that is the same conversation continuing (a `/clear`, a
fork), and the two must not be read as one. `SessionSummary` carries it as
`relay_from`, omitted when empty.

### Subscription DDL (migration 0044)

```sql
ALTER TABLE sessions ADD COLUMN subscription TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_subscription
  ON sessions(subscription) WHERE subscription <> '';
```

The sign-in a session ran on ([ADR-048](08-decisions.md)): a subscription id
from `config.json`, or `''` for the Default sign-in and for every session
stored before. The first non-empty value written is kept — the spawn knows it
before any event arrives, and a session cannot move between sign-ins. Written
by `POST /v1/agents`, by any hook or transcript line whose transcript path is
under `<data dir>/profiles/<id>/`, and by a subscription's Codex importer.
`SessionSummary` carries it as `subscription`, omitted when empty.

### Saved prompts DDL (migration 0045)

```sql
CREATE TABLE IF NOT EXISTS saved_prompts (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('prompt','command')),
  name       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  project_id INTEGER,                -- NULL = every project
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,       -- unix ms
  updated_at INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_saved_prompts_project ON saved_prompts(project_id);
```

Saved prompts and commands ([ADR-051](08-decisions.md), § Saved prompts and
commands). No foreign key: unlisting a project (`archived_at`) keeps its
rows, and nothing deletes a project row.

### Inbox DDL (migration 0053)

```sql
CREATE TABLE IF NOT EXISTS inbox (
  id          INTEGER PRIMARY KEY,
  text        TEXT    NOT NULL DEFAULT '',
  files       TEXT    NOT NULL DEFAULT '[]',
  project_id  INTEGER,                -- NULL = the Inbox, no project
  from_device TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at);
```

What was saved for later (§ Inbox). `files` is a JSON array of paths the
daemon wrote under `<data_dir>/inbox`. No foreign key: unlisting a project
keeps its items, as it keeps its saved prompts.

### Second Brain DDL (migrations 0055, 0056)

Second Brain's graph and the automatic extraction's reads (§ Second Brain,
[ADR-063](08-decisions.md)). This is the initial DDL; migrations 0062 and
0069 extend it below (§ Obsidian vaults DDL, § Second Brain find and
decisions DDL). Writes go through `internal/store`.

```sql
CREATE TABLE IF NOT EXISTS brain_nodes (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('idea','decision','finding','question','topic','person','project')),
  title       TEXT    NOT NULL,
  norm        TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  session_id  TEXT    NOT NULL DEFAULT '',
  event_id    INTEGER,
  source_ts   INTEGER NOT NULL DEFAULT 0,  -- unix ms of the source moment
  project     TEXT    NOT NULL DEFAULT '',
  manual      INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0,1)),
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  run_id      INTEGER,                     -- brain_runs.id; NULL when manual
  created_at  INTEGER NOT NULL,            -- unix ms
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_nodes_entity ON brain_nodes(kind, norm)
  WHERE kind IN ('topic','person','project');
CREATE INDEX IF NOT EXISTS idx_brain_nodes_created ON brain_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_session ON brain_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_event ON brain_nodes(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brain_nodes_project ON brain_nodes(project, created_at);

-- 0056
ALTER TABLE brain_nodes ADD COLUMN search TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS brain_edges (
  src         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('relates','follows','contradicts','part_of')),
  weight      REAL    NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind),
  CHECK (src != dst)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges(dst);

CREATE TABLE IF NOT EXISTS brain_runs (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT    NOT NULL,
  from_event_id    INTEGER NOT NULL DEFAULT 0,
  through_event_id INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL CHECK (status IN ('ok','failed','skipped')),
  model            TEXT    NOT NULL DEFAULT '',
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL    NOT NULL DEFAULT 0,
  nodes            INTEGER NOT NULL DEFAULT 0,
  error            TEXT    NOT NULL DEFAULT '',
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_runs_session ON brain_runs(session_id, id);
CREATE INDEX IF NOT EXISTS idx_brain_runs_finished ON brain_runs(finished_at);
```

`search` (0056) is the folded title, summary and project, one per line, the
title first (`store.BrainSearchDoc`), written on every insert and update.
SQL cannot fold Unicode, so the rows that exist when the migration runs are
filled by `Store.Open` after it; `meta.brain_search_fold` names the folding
they were written with, and a new one re-folds every row once. A search reads
the column for the memories that pass its other filters and matches in Go
(§ Second Brain, *Search*): no index serves a substring, and SQLite's
`LIKE` and `instr` measured slower than Go's byte search on the same rows.

`norm` is the title folded for comparison (`store.NormTitle`); the partial
unique index makes an entity one per normalised title while memories may
share one. Deleting a node deletes its edges (foreign keys are on), and the
topics and people the delete leaves unlinked go too unless dropped in by hand
or pinned. A session's newest `brain_runs` row says how far the extraction has
read it (`through_event_id`, never past a passage it did not send); `tokens_in` is input, cache read and cache write
as `claude` reported them, `cost_usd` its own `total_cost_usd`. A row with
`session_id` `caprock:retag` is a re-tag batch, not a read: its
`from_event_id` and `through_event_id` are memory ids (§ Second Brain,
*Re-tag*).

### Brain catch-up DDL (migration 0068)

```sql
CREATE TABLE IF NOT EXISTS brain_gaps (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL UNIQUE,     -- the brain_runs read that skipped it
  session_id    TEXT    NOT NULL,
  from_event_id INTEGER NOT NULL,
  to_event_id   INTEGER,                     -- last event of the span; NULL until measured
  cursor        INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  reads_total   INTEGER NOT NULL DEFAULT 0,
  reads_done    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT    NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_brain_gaps_status ON brain_gaps(status, id);
ALTER TABLE brain_runs ADD COLUMN gap_id INTEGER;
ALTER TABLE brain_runs ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO brain_gaps (run_id, session_id, from_event_id, cursor)
  SELECT id, session_id, from_event_id, from_event_id FROM brain_runs WHERE status = 'ok';
```

A gap is the span of one past read that the read never sent: the
session's events after `from_event_id` up to and including `to_event_id`,
read up to `cursor`. Every successful read existing when the migration runs
is listed, unmeasured (`to_event_id` NULL); the daemon measures them
(§ Second Brain, *Catch-up*), deleting the rows that skipped nothing, so a
measured row is a real gap. `reads_total` is the reads it was measured to
take, set to `reads_done` when it is done or given up; `attempts` the
failed reads in a row, reset by one that succeeds. A read with `gap_id`
set is a catch-up read and a read with `held = 1` left a short, open tail
for later; neither counts toward a session's cursor (the newest
`through_event_id` of its other reads that did not fail), and catch-up
reads are left out of a session's failure count. A held read's
`through_event_id` is the session's newest event when it was held.

### Obsidian vaults DDL (migration 0062)

[0062_brain_obsidian.sql](../internal/store/migrations/0062_brain_obsidian.sql)
rebuilds `brain_nodes` with `note` in its kind CHECK and nullable `vault_id`,
restoring all prior columns, indexes and edges. It copies edges before the
node rebuild so foreign-key cascades cannot destroy the graph. The new
`idx_brain_nodes_vault` indexes non-NULL ownership. No session or historical
cost row changes.

`brain_vault_notes` tracks each file's source and metadata independently of
its shared node. `brain_vault_edges` tracks imported edge claims; `pre = 1`
means the edge is independent of imports (it existed before, or a manual or
extracted link subsequently adopted it). It is removed only when no other
vault needs it and it has no independent owner. Removing a vault settles
shared nodes from remaining source rows and drops only exclusive material.

```sql
CREATE TABLE IF NOT EXISTS brain_vaults (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  path        TEXT    NOT NULL UNIQUE,
  agents      INTEGER NOT NULL DEFAULT 0 CHECK (agents IN (0,1)),
  notes       INTEGER NOT NULL DEFAULT 0,      -- Markdown notes read at the last scan
  scanned_at  INTEGER NOT NULL DEFAULT 0,      -- unix ms; 0 before the first
  scan_ms     INTEGER NOT NULL DEFAULT 0,      -- how long the last scan took
  error       TEXT    NOT NULL DEFAULT '',     -- why the last scan failed; '' when it did not
  created_at  INTEGER NOT NULL
);

-- 3. One row per note file: the source mark on its node. Two files with the
--    same title or alias share a node and keep a row each, with their own
--    excerpt; nothing is glued together. keys is the note's title and
--    aliases normalised (store.NormTitle), one per line; links and tags are
--    what the file says, one per line, so a refresh can resolve them again
--    without reading unchanged files.
CREATE TABLE IF NOT EXISTS brain_vault_notes (
  id          INTEGER PRIMARY KEY,
  vault_id    INTEGER NOT NULL REFERENCES brain_vaults(id) ON DELETE CASCADE,
  path        TEXT    NOT NULL,                -- in the vault, slash-separated
  node_id     INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  aliases     TEXT    NOT NULL DEFAULT '',
  keys        TEXT    NOT NULL DEFAULT '',
  links       TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',
  project     TEXT    NOT NULL DEFAULT '',
  excerpt     TEXT    NOT NULL DEFAULT '',
  mtime       INTEGER NOT NULL DEFAULT 0,      -- the file's, unix ms
  size        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vault_id, path)
);
CREATE INDEX IF NOT EXISTS idx_brain_vault_notes_node ON brain_vault_notes(node_id);

-- 4. The edges a vault's import made or also wants. An edge is removed only
--    when no vault wants it any more and it did not exist before an import
--    first claimed it (pre = 1).
CREATE TABLE IF NOT EXISTS brain_vault_edges (
  vault_id    INTEGER NOT NULL REFERENCES brain_vaults(id) ON DELETE CASCADE,
  src         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  pre         INTEGER NOT NULL DEFAULT 0 CHECK (pre IN (0,1)),
  PRIMARY KEY (vault_id, src, dst, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_brain_vault_edges_edge ON brain_vault_edges(src, dst, kind);
CREATE INDEX IF NOT EXISTS idx_brain_vault_edges_dst ON brain_vault_edges(dst);
```

### Second Brain find and decisions DDL (migration 0069)

[0069_brain_find_decisions.sql](../internal/store/migrations/0069_brain_find_decisions.sql)
(§ Second Brain, *Search*, *Current decisions*; § SessionStart handoff):

```sql
ALTER TABLE brain_nodes ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
-- brain_edges rebuilt as 0062 did, its rows copied across, with:
--   kind TEXT NOT NULL CHECK (kind IN ('relates','follows','contradicts','part_of','supersedes'))
CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges(dst);
CREATE INDEX IF NOT EXISTS idx_brain_edges_supersedes ON brain_edges(dst) WHERE kind = 'supersedes';
ALTER TABLE sessions ADD COLUMN handoff_runes INTEGER NOT NULL DEFAULT 0;
```

- **`keywords`** — a memory's English search keywords joined with `, `;
  `brain_nodes.search` carries them, folded, on a fourth line, and search
  weighs them like the title. `''` for memories made before 0069 and by
  hand, until the extraction's re-tag gives them some (§ Second Brain,
  *Re-tag*; no migration of its own).
- **`supersedes`** — an edge from a newer decision to the older one it
  replaces. Nothing references `brain_edges`, so the rebuild is a copy
  aside, a drop, a create and a copy back, inside the migration's
  transaction. The partial index answers "is this superseded" for the
  current-decisions read, the handoff and every search.
- **`handoff_runes`** — the length of a new session's handoff reply in
  runes; 0 when nothing was handed.

### Turn bounds DDL (migration 0048)

```sql
CREATE INDEX IF NOT EXISTS idx_events_turn_bounds
  ON events(session_id, ts, kind, agent_id)
  WHERE source = 'hook' AND kind IN ('turn.user', 'agent.stop', 'throttle');
```

Where Claude Code's turns begin and end (§ Queue), partial and covering. On
a copy of the owner's database (2026-10-12, 2 GB) it holds 16k rows; one
project's turns read in 1 ms through it against 1.6 s cold and 47 ms warm
through `idx_events_kind_id`, and building it took 4 s, once.

### Branch spend DDL (migration 0051)

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_repo_branch ON sessions(repo_root, git_branch);
```

The Branches view sums Caprock's spend per branch of one repository
(§ Session branches): `WHERE repo_root = ? GROUP BY git_branch`, joined to
`session_stats` by its key. Without it the read scans every session row.

### Queued messages DDL (migration 0047)

```sql
CREATE TABLE IF NOT EXISTS queued_messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,       -- unix ms
  updated_at INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_queued_messages_session ON queued_messages(session_id, id);
```

Messages waiting for an owned session's turn to end ([ADR-053](08-decisions.md),
§ Queued messages), sent oldest `id` first. No foreign key: a session's rows
are deleted when its process exits.

Migration 0064 adds where a message came from ([ADR-081](08-decisions.md)):

```sql
ALTER TABLE queued_messages ADD COLUMN via TEXT NOT NULL DEFAULT '';
```

`'telegram'` for a message forwarded to the paired bot, `''` for everything
typed in Caprock.

### Attempts DDL (migration 0046)

```sql
CREATE TABLE IF NOT EXISTS attempts (
  session_id  TEXT    PRIMARY KEY,
  group_id    TEXT    NOT NULL,
  n           INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  base        TEXT    NOT NULL DEFAULT '',
  base_commit TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL          -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_attempts_group ON attempts(group_id);
```

One prompt, N attempts ([ADR-052](08-decisions.md)). `group_id` is 16 hex
characters from the daemon; `base` the branch asked for (empty for HEAD);
`base_commit` the commit the copy's HEAD named when it started. Sessions read
it with a correlated subquery in `sessionCols` (one primary-key lookup per
row). Nothing deletes a row: removing a session or its copy leaves the
record of what was tried.

### Pending permission DDL (migrations 0039, 0042, 0043)

```sql
-- 0042 rebuilt 0039's one-row-per-session table as a queue, rows carried over;
-- 0043 added agent_type.
CREATE TABLE pending_permissions (
  session_id  TEXT    NOT NULL,
  prompt_id   TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  always      TEXT    NOT NULL DEFAULT '',
  since       INTEGER NOT NULL,              -- unix ms the dialog was drawn
  input       TEXT    NOT NULL DEFAULT '',
  tool_use_id TEXT    NOT NULL DEFAULT '',
  agent_id    TEXT    NOT NULL DEFAULT '',
  agent_type  TEXT    NOT NULL DEFAULT '',   -- 0043: the subagent's type, '' for the main thread
  PRIMARY KEY (session_id, prompt_id)
);
```

The permission prompts an owned session waits on ([ADR-035](08-decisions.md)),
kept across a daemon restart: one row per prompt, read back oldest first
(`since`, then insertion order). A later `PermissionRequest` adds a row beside
the others and never replaces one; which of several the terminal shows is not
known, so none of them is answered by a button while there are two or more.
`tool_use_id` is the call's id — the hook's when it sends one, else the
matching `PreToolUse`'s; `agent_id` is set when a subagent asked, so its
`SubagentStop` clears its rows, and `agent_type` names it on the card after a
restart.

A new prompt's row is committed on the `PermissionRequest` hook's own request,
before the hook is answered and before the prompt is served, so a daemon killed
the moment after (a crash, or a Windows stop, which has no SIGTERM) still finds
it. A prompt a button answers or dismisses has its row deleted before the
`POST /v1/agents/{id}/permission` returns (after the key is typed), since a
session may write no event that says the dialog went; one cleared by a
keystroke or a hook is deleted off the caller's goroutine, so a keystroke never
waits on the database. The writes are serialised and each rewrites the
session's queue as it stands when it runs. On reattach a Claude
Code session gets each prompt back under the same `prompt_id`, so the `409`
check holds, unless the session recorded a `tool.post`, `turn.user`,
`turn.assistant`, `agent.stop` or `session.end` after that prompt's `since` (a
later `permission.prompt` no longer counts: it queues behind); rows of
sessions not reattached are deleted.

### Removed sessions DDL (migration 0040)

```sql
CREATE TABLE IF NOT EXISTS removed_sessions (
  session_id TEXT    NOT NULL PRIMARY KEY,
  removed_at INTEGER NOT NULL,            -- unix ms
  cwd        TEXT    NOT NULL DEFAULT '',
  cost_usd   REAL    NOT NULL DEFAULT 0
) WITHOUT ROWID;
```

A tombstone per session the owner removed ([ADR-037](08-decisions.md)); the
session's own rows are gone. `rollup.Record` checks it inside its transaction
and stores nothing for a listed session.

### Native id DDL (migration 0032)

```sql
ALTER TABLE sessions ADD COLUMN native_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_native
  ON sessions(agent, native_id) WHERE native_id <> '';
```

The agent's own id for a Codex or OpenCode session Caprock started under an id
of its own — the Codex thread id or the OpenCode session id
(`internal/sessionlink`, [ADR-031](08-decisions.md)). Written once
(`store.SetNativeID` only fills an empty column). The Codex and OpenCode
importers look an agent id up here (`store.SessionForNative`) and file that
session's events under the Caprock session instead; a Codex subagent's events
follow its parent's link. Empty for every other session, including Claude Code
and Gemini, which take Caprock's id on the command line. `SessionSummary`
carries it as `native_id`, omitted when empty. The staleness sweep judges an
**owned** Codex or OpenCode row by its pid like any session Caprock started;
imported rows stay clock-judged.

### Turn message-id DDL (migration 0029)

```sql
CREATE INDEX IF NOT EXISTS idx_events_turn_msg
  ON events(msg_id, session_id)
  WHERE kind = 'turn.assistant' AND msg_id IS NOT NULL;
```

Finds an assistant turn by message id across sessions — the per-turn
`store.TurnPaidElsewhere` lookup on the write path and the GROUP BY in
`rollup.RepairForkedTurns` (see **A turn is paid once across sessions** under
Hook shim). An index leading on `session_id` cannot answer either.
On the owner's database (2026-10-03) the repair found 827 copied turns from
one fork and took $212.93 and 381M tokens out of the totals.

### Turn agent DDL (migration 0031)

```sql
CREATE INDEX IF NOT EXISTS idx_events_turn_agent
  ON events(kind, ts, session_id, agent_id, model, cost_usd,
            tokens_in, tokens_out, cache_read, cache_write, cache_write_1h, internal)
  WHERE kind = 'turn.assistant';
```

Covers the two all-time reads behind `GET /v1/glance`: assistant turns grouped
by session and agent id (`store.AgentSplit`) and tokens by model and type
(`store.TokensByModel`). No earlier index holds `agent_id` or
`cache_write_1h`, so both read every turn's row. On the owner's 1 GB database
(2026-10-04) they took 3.5 s and 2 s; covered, 0.09 s and 0.06 s. The index
is 11.8 MB there and took 1.8 s to build.

### Subagent rows DDL (migration 0049)

```sql
CREATE INDEX IF NOT EXISTS idx_events_agent
  ON events(session_id, agent_id, ts)
  WHERE agent_id IS NOT NULL;
```

A subagent's own rows without walking its parent's: § One subagent, and the
per-agent lookups of § Subagents now, which SQLite moves onto it by itself.
Main-thread rows carry a NULL `agent_id` and stay out. On the owner's 2 GB
database (2026-10-12) it is 16 MB over 229,000 subagent rows and took 4.5 s
to build.

### Subagent reads DDL (migration 0054)

```sql
CREATE INDEX IF NOT EXISTS idx_events_agent_task
  ON events(session_id,
            (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tool_response.agentId') END),
            (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tool_response.description') END))
  WHERE kind = 'tool.post' AND tool IN ('Agent', 'Task');
CREATE INDEX IF NOT EXISTS idx_events_subagent_turn
  ON events(session_id, agent_id, ts, model, cost_usd, tokens_in, kind, internal)
  WHERE kind = 'turn.assistant' AND agent_id IS NOT NULL AND internal = 0;
CREATE INDEX IF NOT EXISTS idx_events_agent_ts
  ON events(session_id, ts, agent_id, kind)
  WHERE agent_id IS NOT NULL;
```

What § Subagents now reads, every two seconds per open cockpit while
subagents work, without the parent session's rows. Before, three of its
reads walked every row of the session and read each from the table — and
`agent_id`, `internal` and `cost_usd` sit after `payload`, so every row also
walked its payload's overflow pages. The installed daemon's slow-query log
named `describeSubagents` 441 times, `SubagentsSpend` 312 and
`LiveSubagents` 48 in under two hours with nine live sessions (2026-10-14).

- **`idx_events_agent_task`** holds the agent id and the description each
  parent `Agent`/`Task` result names, as expressions, so
  `store.describeSubagents` looks up the listed agents by id and opens no
  payload. The query must spell the expressions exactly as the index does
  (`store.agentTaskID`, `store.agentTaskDesc`); a test checks the plan seeks
  on them. `json_valid` guards the extraction because `json_extract` raises
  on malformed JSON, which in an index expression would fail the `INSERT`.
- **`idx_events_subagent_turn`** covers `store.SubagentsSpend`. `kind` and
  `internal` are columns as well as conditions: SQLite counts an index as
  covering only when it holds every column the query names.
- **`idx_events_agent_ts`** covers the live counts (`store.LiveSubagents`,
  `SubagentsNow`, `SubagentsDone`), which seek the last 30 minutes of a
  session. `idx_events_agent` (0049) leads on the agent and cannot seek on
  the window. The queries spell `agent_id IS NOT NULL AND agent_id <> ''`;
  `COALESCE(agent_id, '') <> ''` hides from SQLite that the partial index
  holds every row they need.

Measured on a copy of the owner's 2.4 GB database (2026-10-14; 517,000
events, its busiest session 95,706 of them, 75,855 its subagents'), warm,
through the Go driver, medians of five over interleaved runs:

| Read                                      | Before    | After      |
| ----------------------------------------- | --------- | ---------- |
| Descriptions (every Agent result read)    | 61–82 ms  | 0.1 ms     |
| `SubagentsNow`                            | 77–105 ms | 11–17 ms   |
| `SubagentsDone` (three recent)            | 72–101 ms | 4–6 ms     |
| `SubagentsSpend`                          | 75–97 ms  | 10–14 ms   |
| `LiveSubagents`                           | 3.6–5 ms  | 1.7–2.8 ms |
| Agent types of 30 finished (`?recent=30`) | 276 ms    | 1.5 ms     |

The last row is `store.typeSubagents`, rewritten rather than indexed: one
lookup per agent, newest first through `idx_events_agent`, stopping at the
first event that names a type, where one pass had read the type off every
event of every listed agent. The three indexes are 60 KB, 8.2 MB and 21.3 MB
there over 597 Agent results, 75,244 subagent turns and 271,249 subagent
rows, and took 8.7 s to build, once.

### First-prompt DDL (migration 0033)

```sql
CREATE INDEX IF NOT EXISTS idx_events_user_turn
  ON events(session_id, ts)
  WHERE kind = 'turn.user';
```

`store.FirstPrompts` pins it with `INDEXED BY`. Every untitled row of
`/v1/sessions` is described by its first substantive prompt, and without an
index leading on `session_id` that knows the kind, SQLite walked every
`turn.user` in the database through `idx_events_kind_ts` and read each row to
test its session: 330ms of a 50-row page on the owner's 1 GB database, 600ms
cold. With the partial index the same page's prompts take ~5ms. The implicit
rowid tail gives the query's `ORDER BY ts, id` with no sort.

### Task-list DDL (migration 0066)

```sql
CREATE INDEX IF NOT EXISTS idx_events_todo
  ON events(session_id, ts)
  WHERE kind = 'tool.pre' AND tool IN ('TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan');
```

`store.SessionTodos` pins it with `INDEXED BY` and writes the four names into
the statement rather than binding them: SQLite uses a partial index only when
it can see that the query's WHERE implies the index's. The Work board reads a
session's task list each time the session writes, and through
`idx_events_attr_work` that walked the session's whole index range: 4,820 page
reads for the owner's largest session (180k events) against 10, on a copy of
the database (2026-10-21). The index held 7 pages there; building it read the
table once, 7.7 s in the `sqlite3` shell.

### Busy-loss re-read (migration 0034)

```sql
UPDATE transcript_offsets SET offset = 0 WHERE updated_at >= 1790985600000;
```

A data repair, no DDL. Migration 0029 made the recorder's transaction read
before writing, which a plain `BEGIN` cannot do under contention (see
[02-architecture.md](02-architecture.md), *How the database is opened*), and the
tailer moved past every line whose write failed. Zeroing the offset of every
transcript read since 0029 was merged (2026-10-03 00:00 UTC) makes the tailer
read each once more from the start; keyed dedupe on `(session_id, key)`
stores only what is missing. On a copy of the owner's database (2026-10-04):
55 transcripts, 414 MB, ~20 s, and 259 assistant turns worth $18.52
recovered, all dated after the cutoff.

### Session pull requests DDL (migration 0035)

```sql
CREATE TABLE session_prs (
  session_id TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  opened_at  INTEGER NOT NULL DEFAULT 0,  -- unix ms of a recorded "created", 0 if none
  merged_at  INTEGER NOT NULL DEFAULT 0,  -- unix ms of a recorded "merged", 0 if none
  closed_at  INTEGER NOT NULL DEFAULT 0,  -- unix ms of a recorded "closed", 0 if none
  last_at    INTEGER NOT NULL,            -- unix ms of the latest command on it
  PRIMARY KEY (session_id, url)
);
CREATE INDEX idx_session_prs_last ON session_prs(last_at);
```

A pull request a session created, merged or closed. Claude Code's
PostToolUse payload for a `Bash` call that ran `gh pr …` carries
`tool_response.gitOperation.pr` — `{number, url, action}`, with `action` one
of `created`, `merged`, `closed`, `edited`, `commented` — and the rollup
records `created`, `merged` and `closed` in the same transaction as the event
(`gitremote.FromToolPost`, `store.RecordPR`). Without that record, a
`gh pr create` whose output carries a PR URL is recorded as opened. A PR is
**never shown as merged unless a merge was recorded**: an ended session is not
a merged PR. `meta.session_prs_backfilled` gates a one-off pass over the
`tool.post` rows already stored (`store.PRToolPosts`), run in the background
after the port opens.

### Touch attribution DDL (migration 0012)

```sql
ALTER TABLE events ADD COLUMN msg_id TEXT;      -- assistant message id; links a tool call to the turn that paid
ALTER TABLE events ADD COLUMN touch_dir TEXT;   -- directory the tool touched, slash-normalized; NULL when none
CREATE INDEX IF NOT EXISTS idx_events_touch ON events(kind, ts, session_id, msg_id, touch_dir);
CREATE INDEX IF NOT EXISTS idx_events_msg ON events(session_id, msg_id) WHERE msg_id IS NOT NULL;
-- both dropped by migration 0057 (§ Superseded indexes DDL)

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
- **Codex's `exec` is classified by the tool its script ran (migration 0038).** `exec` wraps a JavaScript script that calls the real tools (`tools.exec_command(…)`, `tools.apply_patch(…)`); of 13,086 calls on the owner's machine 63% ran a command and 14% applied a patch, so counting every `exec` as a command read 30-day editing as 0.4% of spend instead of 4.8% (2026-10-05). `store.innerTool` names the tool when the event is written — of several, the one whose kind wins the precedence; `exec` when the script names none — into `events.inner_tool`, and the scan classifies `COALESCE(inner_tool, tool)`. Stored, not read from the payload in the scan, because that broke the covering index: 30-day summary ~270 ms → ~760 ms. Migration 0038 adds the column to `idx_events_attr_work`; `Store.backfillInnerTool` fills rows already stored (Go, so the script is read by one regex), gated by the `inner_tool_backfilled` meta key.
- **Why `tool` had to enter the index.** The scan reads it per row, and it was carried by no existing index, so the plan fell off the covering path onto the table: **~578 ms** against **~80 ms** covering. Migration 0014 widens `idx_events_attr` into `idx_events_attr_work` and drops the original; SQLite cannot add a column to an index in place, and a stale duplicate would cost write throughput on every ingested event for nothing.

### Superseded indexes DDL (migration 0057)

```sql
DROP INDEX IF EXISTS idx_events_touch;
DROP INDEX IF EXISTS idx_events_ts_model;
DROP INDEX IF EXISTS idx_events_cost_cover;
DROP INDEX IF EXISTS idx_events_msg;
```

Four indexes whose queries later indexes took over, dropped for the space they took: 125 MiB of a 1041 MiB database of 519,000 events, measured after a full VACUUM (2026-10-15). Which index each query uses was read from `EXPLAIN QUERY PLAN` of every statement the Go test suite runs, against a copy of that database; nothing else changed plan.

- **`idx_events_touch`** served the attribution scan, which has run on `idx_events_attr_work` since migrations 0013 and 0014 (§ Touch attribution DDL).
- **`idx_events_ts_model`** served a model mix filtered on `ts` alone. The model mix now also filters on `kind = 'turn.assistant'` and is answered from `idx_events_turn_agent`, which covers it.
- **`idx_events_cost_cover`** had one reader left, `store.WhereWeLeftOff`, which pinned it for its (kind, ts, session_id) prefix. It pins `idx_events_turn_agent` now, which leads on the same columns for assistant turns: 0.42 ms on a hit either way, 37.4 ms against 37.7 ms for a project with no passage.
- **`idx_events_msg`** had one reader left, OpenCode's `refreshText`, which now pins `idx_events_session_id`: 0.52 ms against 0.54 ms for a 401-event session. Unpinned, SQLite falls to `idx_events_kind_id` and takes 441 ms.
- **The space comes back the usual way:** by incremental vacuum, or by the one-time idle VACUUM on a database not yet switched to it (§ Payload compaction and auto-vacuum).

### Rate-limit snapshots DDL (migration 0005)

```sql
CREATE TABLE rate_limit_latest  (window TEXT PRIMARY KEY, ts INTEGER, session_id TEXT, used_percentage REAL, resets_at INTEGER);
CREATE TABLE rate_limit_history (ts INTEGER, window TEXT, used_percentage REAL, resets_at INTEGER);
```

`rate_limit_latest` holds the current state per window (upserted); `rate_limit_history` is a throttled sample (≥30s apart) used to compute an honest "at current pace" forecast. Fed by the statusline (below).

**Migration 0030** deleted samples from both tables whose reset lies more than eight days after the sample — the rule `api.plausibleRateWindow` applies on write. On the owner's database that was 8 history rows of a test fixture (resets_at 1900000000) posted by an unisolated unit test.

**Codex's windows share `rate_limit_latest` under a `codex_` prefix** —
`codex_five_hour`, `codex_seven_day` — so they sit beside Claude Code's
`five_hour` / `seven_day` rows and never replace them. No DDL change: `window`
is free text, and the migration-0005 comment listing two values is history.

- **Written by the Codex importer** from `token_count.rate_limits` in a rollout
  transcript: only `limit_id` `codex` or absent (pre-limit_id CLIs), each
  window named by its length (290–310 min → `five_hour`, 10000–10160 →
  `seven_day`; anything else skipped), `used_percent` 0–100, `resets_at` unix
  seconds (0 where Codex wrote null) and no more than 8 days after the sample.
- **`ts` is when Codex wrote the sample**, not when Caprock read it, and
  `session_id` is the Codex session that carried it.
- **Replaced as a set, newest sample wins** (`store.ReplaceRateLimits`): a newer
  sample deletes every `codex_` row and writes its own windows, so a plan with
  no 5-hour window (`prolite`) leaves none behind from an earlier plan; an older
  sample read later is ignored.
- **No `rate_limit_history` rows**, hence no forecast.

`GET /v1/stats/summary` returns them as `codex_rate_limits` (same shape as
`rate_limits`: `five_hour?`, `seven_day?`, each `{used_percentage, resets_at,
observed_at}` with `observed_at` = that `ts` in unix ms; never `forecast`),
omitted when there are none. Like `rate_limits` it is current state, not
range- or agent-scoped.

**`GET /v1/stats/limits`** answers the two alone — `{rate_limits?,
codex_rate_limits?}`, the same objects from the same reads as the summary's,
each omitted when unknown — for a reader that wants nothing else: the phone
home's *Limits* line ([04-ui.md](04-ui.md) § The phone home), which reads it
on opening and on a pull. A paired device may read it (`pairedDeviceRoutes`).
Measured on a sandbox daemon over a 1.9 GB copy of the owner's database
(2026-10-21, median of 15 warm reads): `/v1/stats/summary?range=today` 6.6 ms
and 22,116 bytes, `/v1/stats/limits` 1.6 ms and 242 bytes. The time is small
either way; the size is what a phone on mobile data, through the relay, pays
for.

**A subscription's windows are stored under `sub:<id>:`** —
`sub:ab12cd34:five_hour` — for either agent ([ADR-048](08-decisions.md)), so
they never replace the Default sign-in's `five_hour` or `codex_five_hour`.
Claude Code's come from the status line: `POST /v1/statusline` carries
`config_dir`, the `CLAUDE_CONFIG_DIR` the command ran under; a directory
directly under `<data dir>/profiles/` names the subscription, and with no
directory the session's own `subscription` does. Codex's come from the
subscription's own importer, replaced as a set like `codex_`. They are read
by `GET /v1/subscriptions` only: `/v1/stats/summary` and the plan-window stop
see the Default sign-in's, and the stop pauses only sessions on it.

## Export (`caprock export`)

`caprock export [events|sessions] [--format tsv|csv|jsonl] [--since 30d|12h|YYYY-MM-DD] [--agent <agent>] [--out file] [--payload]`
writes the normalized record out with a fixed column set. The column sets,
their meaning and the per-agent source mapping are in
[docs/schema.md](../docs/schema.md); that file and `internal/export` change
together.

- **Read-only, daemon not required.** The database is opened through a
  `file:` URI with `mode=ro` (spaces and a Windows drive spelled per SQLite's
  URI rules), so the command cannot write and works with the daemon stopped.
- **Same filter as the dashboard.** `events.internal = 1` rows (Codex's review
  turns) are never exported; a session with no other event is not either.
- **Stable columns, not `SELECT *`.** A column is only ever appended. Renaming,
  removing or reordering one is a breaking change to every script reading the
  output.
- **Content stays out unless asked.** `payload` (prompts, replies, tool output)
  is exported only with `--payload`, and only as jsonl, embedded as JSON.
- **Encodings.** TSV escapes tab, newline, carriage return and backslash as
  `\t \n \r \\`, so one line is one row; CSV is RFC 4180; times are RFC 3339
  UTC with milliseconds, and an unknown value is empty (TSV/CSV) or `null`.
- **`--out` files are created 0600**, like the database they are read from.

## Statusline

`caprock statusline` is registered as Claude Code's `statusLine.command`. Registration is offered by `caprock up` (same consent contract as hooks — TTY prompt or `--yes`) and can be done or reverted explicitly with `caprock statusline install` / `caprock statusline uninstall`; it writes the single `statusLine` key in `~/.claude/settings.json` (backed up once) and never clobbers a statusLine the user set to something else. One entry of ours **is** rewritten: a version quoted the whole command (`"…/caprock statusline"`), which the shell resolves as a single nonexistent filename, so the line printed nothing and said nothing about why — `up` recognises that spelling, repairs it, and says it did. The daemon, at start, also repoints an entry of ours whose program is missing or is another binary (a `/opt/homebrew/bin/caprock` that was uninstalled) at its own stable path (`hooks.RepairPaths`), keeping any flags after `statusline`. Nothing else is normalised; a working command of ours, by any spelling of this binary's path, is left as it is, and a statusLine of the user's own is never touched. Claude Code pipes its status JSON on stdin (per assistant message, 300ms debounce); the command prints a compact one-line status to stdout (`⛰ · model · ctx% · $cost · 5h N% resets HH:MM · 7d N%`) and, best-effort, forwards the `rate_limits` windows (`used_percentage` 0–100, `resets_at` unix seconds) to the daemon via `POST /v1/statusline`. Like the shim it is fire-and-forget and can never break the session: it prints from the stdin JSON **first**, then POSTs with a ≤300ms budget, drops silently if the daemon is down, and always exits 0. `rate_limits` is present only for Pro/Max subscribers (absent → the line still renders, no POST). The daemon's `/v1/stats/summary` returns `rate_limits` (current window state) with a `forecast` string only when the measured usage slope is rising and would reach the limit before the window resets — otherwise the fact alone, never a guess. `limit_at` (unix ms) is set exactly when `forecast` is: the time that same pace reaches 100%, so the dashboard can name the clock time ("around 19:10 — about 1 h before it resets") without parsing the sentence.

The line also carries **the session's own counters**, which the stdin JSON does not: `N turns · N steps · cache −N% · in N · out N`. They are on by default and need no registration change — an existing `… statusline` entry starts showing them on upgrade, with nothing written to the user's settings. `--plain` opts out. `--rich` survives as a hidden no-op so that a settings.json written while it was still a flag keeps working; nothing new registers it. They come from `GET /v1/statusline/{id}` (bearer-gated), which returns `turns`, `tool_calls`, `tokens_in`, `tokens_out`, `cache_read` and `cache_write` from `session_stats` — one indexed row, no derived work, because this runs ahead of a line the user is waiting for. An unknown session returns zeros rather than 404: the first call of a session races its first turn being recorded, and the caller renders both the same way.

**Settings → Status line** (`statusline_mode`: `full`, `short`, `hidden`, `off`; `full` when never chosen) picks what the line shows. The command reads the mode from `config.json` **at render time** (`config.ReadStatuslineMode`: one small file read, one field decoded), so `full` ↔ `short` ↔ `hidden` changes the next line with nothing written to Claude Code's settings; a config that is missing, unreadable or names an unknown mode is `full`, so the line never depends on the read succeeding. `full` is the line above. `short` is `⛰ · model · ctx% · 5h N% · 7d N%` — no cost and no counters — with `resets HH:MM` after the five-hour figure only once it is at 80% or above; it makes **no** counters call to the daemon, and still forwards the plan windows (the cockpit and the Cost screen read them from here). `hidden` keeps Caprock's entry registered and prints **nothing** — no space, no newline — while forwarding the plan windows exactly as `short` does and making no counters call; `config.StatuslineRegistered` is true for every mode but `off`, so the daemon, `caprock up` and subscription prep treat `hidden` like `full`. The settings page recommends `hidden` in words under every other choice; it is never chosen for anyone. `off` removes Caprock's own `statusLine` entry — from `~/.claude/settings.json` and from every Claude Code subscription's directory — through the same ownership check as `caprock statusline uninstall` (`hooks.SetStatuslineOn`): a statusLine the user set is never removed. Choosing any other mode again registers ours wherever no statusLine is set, and never over the user's own. While `off`, `caprock up` does not offer to register it and a new subscription's directory is prepared without it; with no status line, Claude Code's plan windows stop reaching Caprock, which the setting says and points to `hidden`. An entry put back by hand while `off` prints the full line rather than a blank one.

*What Claude Code does with empty output* (read on 2026-10-13 from the statusline docs, <https://code.claude.com/docs/en/statusline>, and from the JavaScript bundled in Claude Code 2.1.296, which was read, not run): the docs say only that a script which exits non-zero or prints nothing leaves the status line "blank", and that notifications share its row outside fullscreen rendering. The bundle settles which kind of blank. The runner trims stdout, trims every line and drops the empty ones, and returns nothing when nothing is left, so an empty string, a single space and a lone newline are the same input. The footer then renders the text when there is some; with none it renders a one-space row only in fullscreen rendering and otherwise nothing, so the row collapses. `hidden` therefore prints nothing at all and exits 0. What remains with any `statusLine` configured: Claude Code still hides most footer keyboard hints (`esc to interrupt`, `? for shortcuts`), per the same docs page. This is a reading of one version's internals, not a documented contract: if a later Claude Code keeps an empty row, `hidden` still forwards the limits and only the row comes back.

This is the one place the safety contract needs defending rather than merely obeying, because the read happens **before** printing. It is bounded at 40ms, and every failure — daemon down, slow, erroring, or answering with junk — falls through to exactly the line plain mode prints. The budget is set from measurement rather than from the 300ms debounce: the endpoint is one indexed row over loopback and answers in ~0.6ms, so 40ms is ~60× the real latency and no healthy daemon approaches it. It is paid in full only in the pathological case — a daemon that accepts the connection and never replies — which measures ~55ms per line end to end against ~10ms otherwise. A stopped daemon (no runtime.json) and a dead one (connection refused) both cost nothing measurable. Registration accepts either form and switches between them in place, so a `--rich` entry is still recognised as ours by `install` and `uninstall`.

The line is fitted to the terminal (`$COLUMNS`, else 80 — Claude Code pipes our stdout, so the file descriptor describes a pipe, not the window). The line leads with the mark — the amber ⛰ the favicon draws, the glyph alone with no wordmark — so it is identifiably Caprock's rather than an anonymous row of figures, at a cost of two columns on something that reprints after every assistant message. Segments carry a rank and are dropped in order: token totals first, then the cache figure, then turns/steps. Neither the mark nor the plan windows are ever dropped. The plan windows are never dropped; they are the number that decides whether work can continue at all. The counters are ranked separately rather than as a block because the full line is 81 columns on a real session — with one rank, a standard 80-column terminal lost all four counters to save a single column.

**The cache figure is what the cache cut off the bill**, not how often it was hit — `cost.ComputeSavings`'s `CutPct`, the same function the Cost screen uses, so the two can never drift apart. The hit rate was the obvious choice and it is worthless on this surface: real sessions read cached tokens in the billions against tens of thousands of uncached input, so every session on the owner's machine rounds to 100.0%. A figure identical for everybody is decoration, and it costs width the useful counters need. The cut varies (83–90% across those same sessions) because it weighs reads and writes by what each is actually charged. A session whose writes dominate has a cut of zero and shows no cache segment at all, rather than claiming a saving it did not make.

Time to first token, tokens per second, and the model-versus-tool time split are **not** shown. No source carries them — hooks do not, and the transcript does not — and the obvious derivation from hook timestamps counts the user's own thinking time as inference. Under [rule 6](../CLAUDE.md) they stay off the line until something real backs them.

### Phase 2 DDL additions

Codex events are keyed `codex:{turn,tool}:<line>` — the record's line number in its transcript, unique by construction in an append-only file. Not the record's `ordinal` field, which reads as 0 in 99 of 100 real transcripts and collapsed every turn of a session onto one key; migration 0022 clears the rows that produced.

A Codex **subagent's** events (`session_meta.source.subagent`) are stored in its parent's session — the file carries the parent's id as `session_id` — keyed `codex:sub:<thread>:{turn,tool}:<line>`, where `<thread>` is the subagent's own `session_meta.id`, with `agent_id` = that thread id and `payload.sidechain = true`, as a Claude Code subagent's are. Under the plain line key they collided with the parent's records on the same line and the file read second lost them (885 of 1,864 subagent turns on the owner's machine). Only subagent files use the longer key: re-keying a file already imported would store every event again. A thread Codex **imported from another agent** (`external-import-turn-*` turn ids) stores no events and no session. Rows earlier versions stored for either are repaired once from the rollouts (`meta.codex_split_repaired`), moving `session_stats` and `daily_stats` with each deleted event in the same transaction; it is code rather than a migration because only the transcripts say which file wrote a row. See [19-codex.md § Imported threads and subagents](19-codex.md#imported-threads-and-subagents).

**Internal events DDL (migration 0024).** Codex writes its hidden approval
reviewer, `codex-auto-review`, into the **same** session as the work it reviews —
it reuses the reviewed session's id — so the classification is per-event, not
per-session. `events` gained `internal INTEGER NOT NULL DEFAULT 0`; migration
0024 backfills `internal = 1` for rows whose model is `codex-auto-review` and
repairs the rollups that had described the review turns as user work:
`daily_stats` drops the review model's rows, `daily_sessions` drops markers only
for review-only sessions, and mixed `session_stats` rows are recomputed from
non-review events while preserving their measured first-touch count. Raw events
stay — they are the source for the `background` figure. The write path
classifies the exact id at insert via `internal/modelclass`, so post-migration
review turns cannot resurrect the rollups. A future similarly named id remains
an ordinary unknown model until separately investigated.

Tables `tasks` (mirror of file state for querying) and `verifications` (`task_id`, `round`, `command`, `exit_code`, `output_path`). Files are the source of truth for hive state; SQLite mirrors them for the UI (rebuildable by rescan). Forced-continue counter for the Stop-loop lives in SQLite per (session, task).

No DDL change was needed for either fix here, only honest use of the existing columns. `verifications.output_path` now holds a real path — `<hive>/verifications/<task-id>/round-<n>-cmd-<i>.log` — instead of the empty string it was always written with, so a green task carries auditable evidence. The forced-continue counter's `task_id` takes the reserved value `/no-task` for a session that owns none (the orchestrator), which is what makes the guard bound it too; a hive id may not contain `/`, so it cannot collide with a real task id.

## Pricing table

- Embedded JSON `pricing/pricing.json` (the spec's "ported from Caprock-python" — authored from the Anthropic pricing page in practice, [ADR-015](08-decisions.md#adr-015--pricing-source-anthropic-first-party-pricing-page-versioned-the-legacy-repo-has-no-pricingjson)); overridable by a user file (`<data_dir>/pricing.json`); `pricing_version` recorded in `meta` so historical cost is never silently recomputed — the one exception is a turn a table version lists under `corrections` (below), which is recomputed openly and logged.
- **Who prices what.** Four of the six sources are priced by this table; two are not. **Hermes Agent** prices its own calls and records whether a figure is the provider's or its estimate; Caprock carries it unchanged with that basis ([ADR-069](08-decisions.md)). Claude Code, Gemini, Codex and **DeepSeek Harness** report tokens and no cost, so the table does the arithmetic. **OpenCode** reports its own cost, which is carried through unchanged — two different arithmetics over the same tokens would give one session two totals. The `source` on an event is what tells a reader which produced a figure. Codex is why the table carries OpenAI rows (`gpt-5-codex`, `gpt-5.3-codex`, and the `gpt-5.6` family, read from developers.openai.com on 2026-09-06; `gpt-6-sol` and `gpt-6-luna`, read 2026-09-29; `gpt-6-astra` and `gpt-6.1-sol`, read 2026-09-30 — the gpt-6 >272K-token tier is not modelled, and no observed turn reached it). `cache_write_*` is `0` on the gpt-5 rows because OpenAI did not charge for writing its cache, which is "not charged" rather than "unknown". The gpt-6 model pages bill cache writes at 1.25x input, so those rows carry it — to no effect yet: Codex reports `cache_write_input_tokens` as 0 on every gpt-6 turn observed, so written tokens arrive as plain input and the gpt-6 rows under-report by up to a quarter of that unknown share. DeepSeek Harness names `deepseek-v4-pro`, already present from the OpenCode third-party rows; its `cache_write_*` is unused because DSH reports no cache-write split.
- **A turn whose model is not in the table is priced once the table has it.**
  It is stored with no cost and sits outside every total, counted as
  unpriced; adding the model's row fixed only the turns after it. On start
  the daemon runs `Recorder.PriceUnpriced` in the background: each such turn
  is priced at the row in force at its own timestamp, and `session_stats` and
  `daily_stats` take the same amount in the same transaction. This is not
  repricing — a turn that was priced keeps its figure. It found 5,788 Codex
  turns (`gpt-6-sol`, `gpt-6-luna`, rows added 2026-09-29) on the owner's
  machine, $96.69 that no total had carried, and on 2026-09-30 the 27
  `gpt-6-astra` turns behind the "Partial cost" line.
- **A gateway's free variant is priced at $0.** An id with no row that ends
  in `-free` (OpenCode Zen: `deepseek-v4.1-flash-free`, issue #787) or
  `:free` (OpenRouter) matches a zero-priced row made in code
  (`cost.isFreeModel`) with no context window, so the session's context reads
  "not in pricing table". The gateway bills nothing for those ids, so the
  figure is measured, not invented; leaving them unpriced asked users to
  report a model that is free by name. A row in the table still wins. Table
  `2026-10-22.1` records it; the turns already stored unpriced are priced by
  `PriceUnpriced` on the next start.
- **Every write to a turn's cost moves the rollups in the same transaction.**
  `session_stats` and `daily_stats` are accumulated, not recomputed, so an
  event whose cost changes without them leaves every screen disagreeing with
  the events it was built from. Migrations 0022 and 0023 broke this: they
  deleted and re-imported every Codex event and zeroed `session_stats`, but not
  `daily_stats`, so the first import stayed in the daily table beside the
  re-import. `Recorder.RebuildCodexDaily` rewrites the Codex rows from events
  once (`meta.codex_daily_rebuilt`), skipping a (day, model) another source
  also used and any day retention may have pruned. Checked on a copy of the
  owner's database: events, `session_stats` and `daily_stats` agree to the cent
  and the token afterwards. Codex's own `repriceSession` now moves both
  rollups too.
- **A turn with no model is stored unpriced.** The recorder prices only when it has a model id; without one the turn keeps its real token counts and carries no cost, and `caprock status` reports the count so a partial total is legible as partial ([rule 6](../CLAUDE.md) — a missing number beats an invented one). For Codex this nearly never happens, but only because the model is read from **two** places: `turn_context` (4 of 100 real transcripts) and `session_meta.base_instructions.provenance` (96). Reading the obvious one alone left 83% of tokens with no cost. Both are recorded model ids rather than inferences; where both appear they agreed, and `turn_context` wins as the per-turn value. See [19-codex.md](19-codex.md).
- **The daily spend cap (`settings.cap_usd_per_day`) pauses sessions Caprock started, and only those.** Zero is off and is the default — a threshold nobody chose would eventually stop work for a reason its owner could not explain. The check runs after a turn is **priced**, not on a timer: the day's total only moves when a turn is priced, so a poll would either lag the crossing or ask the database for a sum it already knows is unchanged. Four rules, each with a test that was verified by breaking it: **only owned sessions** — `agents.PauseOwned` refuses any id the manager did not spawn, so [rule 7](../CLAUDE.md) is enforced at the thing holding the process handles rather than by whoever is calling; **paused, not killed** — SIGSTOP, so the conversation, directory and context survive a resume; **once a day** — a session resumed by hand must not be re-paused seconds later, and the day is claimed under a mutex *before* any signal so concurrent turns cannot both fire; **fails open** — an unreadable spend does not pause, because a missed pause costs money while a spurious one stops work that was fine, and the second is the one nobody forgives. `cap_usd_per_day` carries **no `omitempty`**: zero means "off", and omitting it makes an off cap indistinguishable from a daemon too old to have the field — the panel could then be switched on but never off. A negative or non-finite value is a 400 rather than a clamp, like every other validated field here. The suggested limit is **twice the median day, rounded** (`cap.Suggest`, mirrored in the UI): the median rather than the mean because one runaway day would drag an average up and produce a ceiling that never fires — precisely the day the feature exists for — and twice it because a cap set *at* the median fires half the time by definition. It is offered as a click, never prefilled: a number that appears in the field on its own is a number nobody chose, and this one stops work.
- **The plan-window stop (`settings.window_stop_pct`, Premium) pauses the Claude Code sessions Caprock started when Claude's five-hour or weekly window crosses a share, and resumes them after the reset** (owner decision, 2026-10-08; `internal/cap/window.go`, wired in `internal/daemon/windowstop.go`). It reuses the cap's pause path (`agents.PauseOwned`, plus `ResumeOwned` and `OwnedRunningKind`) and the windows `caprock statusline` already records (`rate_limit_latest`). The rules, each with a test in `internal/cap/window_test.go`:
  - **The setting.** `window_stop_pct` is `0` (off) or `50`–`99`; anything else is a 400. Off until chosen, like the daily cap: a config that never chose reads `0`. The control offers 80, 90 and 95; 90 is the free alert's own line. No `omitempty` on the API field, like the cap.
  - **Licensed only.** Without an active licence (`license.Parse`, grace included) nothing is paused; the free 90% alert on Now is unchanged. A pause already made is still undone at the reset if the licence lapses or the setting is turned off in between.
  - **Only owned Claude Code sessions.** `OwnedRunningKind("claude")`: a Codex, Gemini or OpenCode session Caprock started does not spend Anthropic's window, and a hand-started session is never signalled (`PauseOwned` refuses it, [rule 7](../CLAUDE.md)).
  - **Never on stale figures.** A window is acted on only when its sample is at most 10 minutes old (`cap.FreshFor`), its `resets_at` is in the future, and no more than 8 days ahead. The check runs when `POST /v1/statusline` records new figures and every 30 seconds.
  - **Resume after the reset.** Each paused session waits for the latest reset among the windows over the share when it was paused (a weekly window over the share keeps it paused past the five-hour reset), plus one minute (`cap.ResumeGrace`); then the 30-second tick sends `resume` (SIGCONT, or the input hold released on Windows), and a session that ended meanwhile is dropped.
  - **Once per window.** A stop that paused something latches every window over the share by name and reset time (within 30 minutes, so a reset reported a few seconds differently is the same window). In that window nothing is paused again: not a session the user resumed by hand, not one started after the notice. A stop that found nothing to pause does not latch. Changing the share clears the latches; paused sessions keep their resume time.
  - **The user takes over.** Any `POST /v1/agents/{id}/signal` (pause, resume or kill) on a session the stop paused removes it from the stop's list, so it is not resumed behind the user's back.
  - **State survives a restart.** `{paused:[{session_id, resume_at, window, paused_at}], latched:[{window, resets_at}], last}` is kept as JSON in `meta.window_stop` (no migration); sessions in pty-hosts outlive the daemon (ADR-033) and are resumed by the next one.
  - **The notice.** A `notify` frame of kind `window` (§ Notify frame), and `GET /v1/window-stop`: `{pct, licensed, fresh_for_s, windows:[{window, used_percentage, resets_at, observed_at, fresh, stale?}], paused:[{session_id, project, title?, window, resume_at, paused_at}], last?:{kind, at, window?, used_percentage?, threshold_pct?, resume_at?, sessions}}` — `paused` lists only sessions still owned and still paused; `stale` says why a figure will not be acted on. Now shows a `window-stop` row naming the paused sessions and the reset in place of the plan-limit row, and on an install without a licence the plan-limit row offers the feature (`PremiumModal` feature `window`). Settings → *Pause at the plan limit* is the one control, behind `Locked` without a licence.
- **`GET /v1/browse` lists directories for the folder picker, and is the one endpoint that reads the filesystem on a web page's behalf.** Starting a session required typing an absolute path from memory into a dashboard already showing the reader's repositories. Four rules make this a picker rather than a filesystem-read API: **only directories and only names** (no contents, no sizes); **rooted at `settings.browse_root`** (default `$HOME`), with **symlinks resolved before the containment check** so a link inside the root pointing out of it cannot smuggle a caller past the boundary; **dotfile directories are never listed** — `.ssh` and `.aws` are precisely what a prober wants, while `.git` is reported as a *property* of its parent (`repo: true`) rather than somewhere to descend into; and **"outside the root" and "does not exist" return the identical 404**, so the endpoint cannot be used as an existence oracle for paths the caller may not see. Listings are capped at 500 entries with `X-Caprock-Truncated` set rather than silently cut. Repositories sort first because a repository is what is being looked for. `GET /v1/recent-dirs` is the other half and touches no filesystem beyond an existence check: it lists directories from the `sessions` table, newest first, grouped by repository root where one is known, and omits any that no longer exist — a picker offering a dead path spawns a session that fails. It also omits the filesystem root, the home directory itself and the temp directory itself (`store.NotAProject`): on the owner's Mac a background `claude` opened in "/" every ten minutes and held the top of the list. Since 2026-10-09 it also leaves out anything under a temp directory (`/tmp`, `/private/tmp`, `/var/folders`, `os.TempDir()`), under Caprock's data directory (quick chats live in its `chats/`) and under a `.claude/worktrees/` folder, reading up to 40 directories to fill its 8.
- **`GET /v1/browse/stat?path=` says what a typed path is**, for the Add project sheet's line under its folder field ("exists — not empty, clone will fail", "will be created", "already in Caprock"). → `{path, exists, is_dir, empty, parent_exists, guarded?, project_id?, project_name?}`: `path` absolute, a leading `~` expanded, cleaned; `empty` counts hidden files (git refuses a folder holding a `.DS_Store`); `parent_exists` says one level can be made there; `project_id` is the listed project adding the path would return (its root, or the repository it lies in). Held to the browse rules: the same root (a device's rooted inside home), the nearest existing part of the path resolved through symlinks before the containment check, and the browse `404` for a relative path or anything outside the root, whether or not it exists there. A path in a place macOS guards (`tcc.Guarded`: Documents, Music, a volume…) is answered `{path, guarded: true}` without being read. A controller may ask it, as it may browse.
- **`GET /v1/browse/repos` lists the git repositories under the default folder**, for the project search in New agent and Add a project (2026-10-10). → `{root, home?, scanned_at, truncated?, repos: [{name, path}]}`: `root` is `settings.default_folder` (`~` expanded) when it resolves inside the browse root, otherwise the browse root itself (a device's is rooted inside home); `home` lets the page write `~/dev/x`. A repository is a directory holding `.git`, one or two levels below `root`; one is never descended into, and hidden directories, `node_modules` and places macOS guards (`tcc.Guarded`) are skipped — a guarded `root` answers an empty list without reading it. Names and paths only, as `/v1/browse`. At most 1000 repositories from at most 4000 directories opened (`truncated: true` past either). The answer is cached per root for 60 s and a stale one is served while a background rescan runs, so only a sheet's first open on a daemon waits for a scan. The page searches the answer itself; it never walks the disk.
- **The weekly report states what changed, not what happened.** It is sold on the promise of the repository that cost 3× its usual week and of last week against the one before it, per repository and model — so it must ship as a comparison against the preceding period, not as a digest of the current one. This is not a presentation choice: five readers were shown a digest-shaped description of it and every one of them concluded they would be paying for delivery of figures the free dashboard already shows (FB-027). A digest is a notification; what moved is the thing a week of data can say and a live screen cannot.
- **`/v1/history` and the wide ranges of `/v1/stats/summary` are cached, with single-flight and stale-while-revalidate** (`internal/api/answercache.go`). Both answer from aggregates over the whole events table — on the owner's 1 GB, 333k-event database `/v1/history?range=all` is ~1.5s and `/v1/stats/summary?range=all` ~1.0s through the Go driver, and 4.7s and 1.5s under a live dashboard (2026-10-04) — and they are asked for in bursts: **five components on the main screen request history on their own timers**, and the share dialog asks for its period's summary (or all-time history) beside the glance. Requests for the same key that arrive while one is in flight wait for it and share its result. A settled answer is served as it is for its TTL (`historyTTL` 3s, `summaryTTL` 10s), and a history answer for **20 times what computing it took** when that is longer (`historyCostScale`, at most `historyCostCeiling` 2 min): today's history, milliseconds to count, keeps the 3 s, while an all-time one that takes a second is refreshed at most every 20 s, so keeping it current costs at most a twentieth of one core however large the history grows — with agents writing, the version always moves and the all-time answer was otherwise counted again on every poll, 40% of the daemon's CPU under the 2026-10-18 profile (resource-usage audit F13). A history that reaches before today (`7d`, `30d`, `all`) is also kept for at least `historyWideTTL` (1 min) however fast it was to count: the cost bound measures wall time, a whole-history scan the page cache answers is fast, and it still reads every event in the range — on a machine short of memory those reads go to disk on every poll (resource-usage audit F16). Today's history keeps the 3 s. The history totals take turns, tool calls, cost, unpriced and background volume from the summary computed beside them (`store.HistoryFrom`) instead of scanning for them a second time; past that it is **still served at once and one background refresh replaces it**, so nobody waits on a whole-table scan once a key has been computed, and what is shown is at most one refresh behind. Past `answerMaxStale` (30 min) an answer is too old to present as current and the caller waits for a fresh one. The daemon computes history for all time and the 7d, 30d and all-time summaries in the background as it starts (`Server.Warm`), so the first screen after a restart finds them ready. **Today's summary is not cached** — it is ~40ms and is the figure people watch move — and neither are the burn rate, throttles and plan windows beside any range, which are read live on every request. Keys carry the range's resolved start as well as its label, so `today`, `7d` and `30d` become new keys at midnight rather than serving yesterday's answer; `?range=` and `?range=today` still share one entry. **Errors are never cached**, and a failed refresh keeps the stale answer. Computations run on a context detached from their first caller: browsers abandon requests routinely, and a caller hanging up must not take the answer away from the callers waiting behind it. Writes do not invalidate — ingest commits several times a second while anyone works, so an invalidated cache would be empty exactly when the screen is busiest. Measured on a copy of the owner's database with a writer committing every 200ms and the main screen's eleven requests fired at once: the slowest went from 3.6s to 0.09s (2026-10-04). `/v1/status` reads its stored-event count the same way, recounted in the background at most every 30 s: a `COUNT(*)` over 333k events is 600ms on a cold connection.
- **Dated prices (migration-free, `pricing.json`).** A model may have more than one row. A superseded price keeps its own row carrying `until` — the last date it applied, inclusive, UTC — and the current price is the row with no `until`; rows for one id are ordered oldest-first. A turn is priced by `LookupAt`/`PriceAt` at **its own timestamp**, so a rate that has since lapsed still prices the turns that ran under it. Without this, the only way to record a price change is to overwrite the figure, which silently restates history at a price nobody was charged — an invented number (rule 6) about our own past. Sonnet 5 was the first case (introductory $2/$10 through 2026-08-30, $3/$15 announced from 2026-08-31) until the rise was cancelled; no row is dated today. A row whose `until` will not parse is treated as not applying, so an unparseable date falls through to the current price rather than pricing a turn at an expired one. Exactly one row per model id may omit `until`, and a test enforces it.
- **Corrections (`pricing.json` `corrections`).** A list of `{model, from?, reason}`: turns an earlier table priced *wrongly* — a missing row that fell through to another model by prefix, or a price change that was announced and cancelled. That differs from a price that changed, which never restates history. On start the daemon (`rollup.ApplyCorrections`) reprices every `turn.assistant` whose model starts with `model` and whose time is on or after `from` (UTC; empty = all), at the row in force at the turn's own timestamp, and moves `session_stats` and `daily_stats` by the difference in the same transaction. It runs once per table version, recorded in `meta.price_corrections`; an interrupted pass is finished by the next start, because a turn already at the corrected figure moves by nothing. A malformed `from` or a correction with no model fails the table load. `2026-10-01.1` corrects `claude-opus-5-5` (all turns, previously priced as Opus 5) and `claude-sonnet-5` from 2026-08-31. `2026-10-03.1` adds `gemini-3.8-flash` and `gemini-3.1-flash-lite` with no correction: neither matched another id by prefix, so their turns were unpriced (named in `unpriced`), not mispriced. `2026-10-08.1` adds `claude-haiku-5-5` (its lower, under-100k tier) with no correction, for the same reason. `2026-10-13.1` adds `deepseek-flash` (DeepSeek's off-peak list price; peak hours bill double and are under-reported) with no correction, for the same reason; it prices Claude Code on DeepSeek. `2026-10-22.1` changes no row: it prices ids ending in `-free` or `:free` at $0 (above), with no correction. The `deepseek-v4-pro` row is unchanged although DeepSeek now lists a higher price, because the date it changed is not known ([OQ-13](12-risks.md#open-questions)).
- Cost per assistant turn = `tokens_in × input + cache_write × cache_write_price + cache_read × cache_read_price + tokens_out × output`, all prices per token (table values are per MTok ÷ 1e6).
- Cache-savings math (ported from Caprock-python `_savings.py`): `billed_with = in + 1.25·cache_write + 0.10·cache_read` in input-token equivalents; `billed_without = in + cache_write + cache_read`; `saved = billed_without − billed_with`; hit-rate reported as `cache_read / (in + cache_read + cache_write)`. Where the transcript reports the 1h-TTL split (`cache_creation.ephemeral_1h_input_tokens`), those tokens are priced at the 1h write price (2×), not 1.25×.
- **Source of the numbers:** Anthropic first-party pricing page (`platform.claude.com/docs/en/about-claude/pricing`), fetched 2026-08-18. Bedrock/Vertex have separate partner pricing — first-party only across v0.1–v0.3; recorded as [OQ-02](12-risks.md#open-questions).
- The parity target and its fixture story: [OQ-01](12-risks.md#open-questions).

### Runner rate table (`pricing/actions.json`)

The GitHub Actions counterpart of the model table, with its own `version`
(first `2026-10-12.1`), embedded as `pricing.ActionsJSON` and parsed once by
`github.EmbeddedRunnerTable`; there is no user override. It prices CI jobs
(§ Runner cost under Phase 1 additions) and nothing else.

- **Shape** — `{version, source, fetched_at, currency: "USD", unit:
  "per_minute", notes[], skus[], labels}`. Each `skus[]` row is `{sku,
  display, os, arch?, usd_per_min, larger?, gpu?}`, `sku` being GitHub's
  billing SKU (`actions_linux`, `linux_4_core_arm`, `macos_xl`…); `larger`
  marks a larger runner, which is never free. `labels` maps a documented
  workflow label to a SKU. Parsing refuses a missing version, a unit other
  than USD per minute, no rows, a negative rate, a SKU listed twice and a
  label naming a SKU with no row.
- **Source** — GitHub's *Actions runner pricing* reference
  (`docs.github.com/en/billing/reference/actions-runner-pricing`), read
  2026-10-12: every standard, x64 larger, arm64 larger and GPU row as
  listed there. The labels come from the GitHub-hosted runners reference
  (private-repository table) and the larger runners reference, read the same
  day. The notes quote the rest with its URL and date: per-job rounding up
  to the whole minute; GitHub's 2025-12-16 changelog saying the hosted rates
  from 2026-01-01 include the $0.002 per-minute platform charge (so nothing
  is added); public repositories free on standard runners; self-hosted usage
  free per the billing page, with the announced self-hosted charge postponed
  — a self-hosted job is still reported unpriced, not $0.
- **Changing it** — a new rate is a new `version` in the same commit as
  this section and `CHANGELOG.md`, with the date it was read; no rate is
  written anywhere in Go, tests included (they read the table).

## Autostart service files

`caprock service install` registers the daemon with the OS's own login supervisor. One user-level mechanism per platform; nothing is written outside the user's home, and never into `~/.claude/`.

- **macOS** — a launchd agent at `~/Library/LaunchAgents/dev.caprock.daemon.plist`, loaded with `launchctl bootstrap gui/<uid>`. `RunAtLoad` starts it at login; `KeepAlive` with `SuccessfulExit=false` restarts a crash but leaves a deliberate `caprock down` alone. No `ProcessType` is declared, deliberately: the daemon watches files, so `Background` with `LowPriorityIO` looks correct and was measured to make the dashboard answer in 1.2s what the same binary answered in 185ms from a terminal; `Adaptive` changed nothing, leaving the process at scheduler priority 4 against a normal 20. Any `ProcessType` puts the job in a managed band, so the key is omitted. `AbandonProcessGroup` is `true`, so stopping the job does not kill what is left in its process group.
- **Linux** — a systemd **user** unit at `~/.config/systemd/user/caprock.service` (honouring `XDG_CONFIG_HOME`), enabled with `systemctl --user enable --now`, `Restart=on-failure`, `KillMode=process`. Without a systemd user session the install fails with an actionable message and writes nothing.
- **Windows** — a `.cmd` script in the Startup folder. A Scheduled Task cannot be rendered into a temp directory for a test, so verifying one means leaving a real logon task in the runner's store; the Startup script is an ordinary user-owned file, so its generation is unit-tested on every OS. The cost is that Windows restarts the daemon at logon but not mid-session.

**`CAPROCK_SERVICE_LABEL`** replaces the label `dev.caprock.daemon` for a second, isolated install — a preview daemon, or the desktop app's supervisor under test with its own data dir and port. It reaches every name the commands act on: the launchd label and plist name, and the stem of the systemd unit (`<label>.service`) and the Startup script (`<label>.cmd`). Unset, or set to anything but letters, digits, `.`, `-` and `_`, the default label and file names are used, so an existing install keeps its files.

**Owned sessions outlive the service's restarts** ([ADR-033](08-decisions.md#adr-033--an-owned-session-outlives-the-daemon-its-terminal-lives-in-a-pty-host)). Each runs under a `caprock pty-host` started in its own session (POSIX `setsid`) or its own process group with its own hidden console (Windows), which is already out of reach of launchd's process-group kill; `AbandonProcessGroup` is the second lock. systemd kills the whole cgroup whatever the process group, so on Linux `KillMode=process` is what keeps them. An install written by an earlier release lacks both keys: `caprock service status` reports the file as differing, and `caprock service install` rewrites it. Until then a macOS install still keeps sessions (the `setsid` alone suffices against a process-group kill); a Linux one does not.

The service runs the daemon with `--foreground` (the supervisor owns the process lifetime, so the daemon must not detach), `--no-open`, and `--no-hooks` — hook and statusline registration stay an interactive consent decision, never something a login agent performs.

## Runtime file

**One daemon per data directory** (2026-10-13). The daemon holds an
exclusive advisory lock on `<data_dir>/caprock.lock` (`0600`) for its whole
life — `flock` on macOS and Linux, `LockFileEx` on one byte at offset 4 GiB
on Windows — taken before the database is opened, and writes its pid into
the file. A second daemon waits up to 5 s (a restart: the app's supervisor,
a login service, an update) and then exits with `another Caprock daemon (pid
N) is already running for this data directory (<dir>)`, the pid read from
the lock file, else from `runtime.json` (which is the previous run's until
the holder listens); `caprock up` shows that line, and the desktop app
waits for that holder rather than failing ([21-app.md](21-app.md)). The
OS drops the lock when the process exits however it exits, so nothing stale
is left; the file stays. Files are opened close-on-exec, so holders never
inherit it. A filesystem that cannot lock at all is logged and run without
the lock rather than refused. Daemons on different data directories (tests,
preview stands) never meet. Before it, the port's bind was the only lock,
which a second daemon on another port walked past.

`<data_dir>/runtime.json` = `{"port": 22776, "token": "<random per run>", "pid": <daemon pid>, "started_at": <unix ms>, "version": "<daemon version>", "api_level": 1, "exe": "<absolute path of the daemon binary>"}`; written 0600 by `caprock up`, deleted by `caprock down`; the shim reads it on every invocation.

**`api_level`** (also in `GET /v1/status`) is an integer raised by every change a client must know about and never lowered: `1` is the first level, added for the desktop app ([ADR-038](08-decisions.md#adr-038--the-desktop-app-is-a-thin-tauri-v2-shell-around-the-existing-react-ui-and-xtermjs-on-the-go-daemon)). A client declares the minimum it needs; a daemon below it, or one with no `api_level` (read as `0`), is shown as needing an upgrade. **`exe`** is how the desktop app tells a daemon it installed (`<data_dir>/bin/caprock`, which it may replace) from one a package manager owns (which it must not touch); omitted when the OS cannot say.

**The desktop app's files in `<data_dir>`.** `bin/caprock` (`caprock.exe` on Windows) is the daemon the app installed, copied from its bundle by write-then-rename; the login service it registers runs that copy. `app.json` = `{"background": true}` records the first-run choice (run as a login service or not); its absence means the app has never started a daemon here, and the first-run screen is shown. `app-update.json` = `{"asked": true}` records that the app's first-launch question about update checks was answered (F20); the choice itself is the daemon's `update_checks`. All three are written by the app, never by the daemon. What `<data_dir>` resolves to per OS is owned by [ADR-013](08-decisions.md#adr-013--data-dir-and-config-conventions).

**The app's update manifest** (F20, [ADR-042](08-decisions.md#adr-042--the-app-updates-itself-in-one-click-a-minisign-signed-bundle-one-channel-checked-only-when-the-release-check-is-on-or-the-user-asks)) is `latest.json` on each release, read at `https://github.com/dspv/caprock/releases/latest/download/latest.json`, in tauri-plugin-updater's static format, written by `scripts/app-update-manifest.py`:

```json
{
  "version": "0.79.0",
  "notes": "https://github.com/dspv/caprock/releases/tag/v0.79.0",
  "pub_date": "2026-10-06T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": ".../download/v0.79.0/Caprock_0.79.0_universal.app.tar.gz", "signature": "<the .sig file's contents>" },
    "darwin-x86_64": { "url": "(the same universal bundle)", "signature": "…" },
    "linux-x86_64-appimage": { "url": ".../Caprock_0.79.0_amd64.AppImage", "signature": "…" },
    "windows-x86_64": { "url": ".../Caprock_0.79.0_x64-setup.exe", "signature": "…" }
  }
}
```

A platform without a signed bundle is absent. The signature is minisign over the bundle, with the version in its trusted comment; the app refuses a mismatch.

### File permissions

Everything Caprock writes into `<data_dir>` is owner-only on POSIX. The data directory is `0700`; `config.json`, `runtime.json`, `telegram.json` and the log are `0600`; and **`caprock.db` plus its `-wal`/`-shm` siblings are `0600`**.

The database is included because it stores prompts and responses in cleartext — that is what makes the Memory screen searchable — so a world-readable mode hands every other local account the user's entire session history. It was previously left at whatever the process umask produced, which under a default umask is `0644`, while `config.json` beside it had always been `0600`.

The mode is applied by `store.secureDBFiles` on **every** `store.Open`, not only at creation: a database written by an earlier version keeps its `0644` until something changes it, and SQLite recreates `-wal`/`-shm` on demand under the umask, so a creation-time fix alone would regress on the next open. A filesystem that refuses `chmod` (a network share, a container volume) produces a logged warning and a running daemon rather than a failed start — a permissions limitation must not become an outage.

**Windows is a deliberate no-op**: NTFS has no POSIX mode bits, `os.Chmod` there only toggles the read-only attribute, and applying `0600` would risk a read-only database while achieving nothing. Access is governed by the ACL inherited from the per-user data directory. The permission tests skip on Windows with that reason (rule 2).

## Terminal holders (`caprock pty-host`)

One process per owned session holds its PTY, so the session outlives the daemon ([ADR-033](08-decisions.md#adr-033--an-owned-session-outlives-the-daemon-its-terminal-lives-in-a-pty-host)). Code: `internal/ptyhost`.

**Starting one.** The daemon runs `<holder> pty-host`, where `<holder>` is `caprock-pty-host[.exe]` from beside the `caprock` executable (or beside the file it links to) when that is a non-empty executable file, and `caprock` itself (the hidden `pty-host` subcommand) otherwise; both run `internal/ptyhost` and are told apart only by memory. It is detached — POSIX `setsid`; Windows `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`, plus `CREATE_BREAKAWAY_FROM_JOB` when the job allows it — with its working directory in the system temp directory. On Windows `<holder>` is a copy of that binary at `<data_dir>/ptyhost/bin/<name>-<sha256[:16]>.exe` (`<name>` is `caprock-pty-host` or `caprock`), so a running session never pins the install directory against `scoop update`; copies nothing runs from are deleted at the next daemon start. The launch spec is one JSON object on the holder's **stdin** — never argv (readable machine-wide) or disk — because it carries the token and the child's environment:

```json
{"proto": 1, "session_id": "<uuid>", "dir": "<data_dir>/ptyhost", "token": "<64 hex>", "version": "<caprock version>",
 "spec": {"ID": "<uuid>", "Meta": {"kind": "claude"}, "Command": "/abs/claude", "Args": ["--session-id", "<uuid>"], "Dir": "<cwd>", "Env": ["K=V", "…"], "Cols": 120, "Rows": 40}}
```

The holder starts the child, listens on `127.0.0.1:0`, writes its registry entry, answers one line on **stdout** — `{"ok":true,"addr":"127.0.0.1:<port>","child_pid":N}` or `{"ok":false,"error":"…"}` — and closes stdout. A holder that cannot be started falls back to the in-process PTY (the session works and ends with the daemon); a child that cannot start is reported as the spawn's error.

**Registry** — `<data_dir>/ptyhost/` (`0700`):

- `<session-id>.json` (`0600`, written atomically by the holder, removed by it when the session ends): `{"proto", "session_id", "host_pid", "child_pid", "addr", "token", "cwd", "command", "started_at", "version", "meta"}`, where `meta` is `{"kind": "claude"|"codex"|"opencode"|"gemini"|"shell", "port": "<OpenCode TUI server port>"}` (`shell` is a shell tab, which has no session row) — what the next daemon needs to keep watching the session (absent from holders written before it existed: treated as the row's agent, else Claude Code). The daemon removes an entry only when nothing listens at `addr` (the holder is gone). Continuing a session under its own id starts a second holder for the same id, so a holder removes the entry — or writes an exit file — only while the entry still names its own `host_pid` and token, and the daemon ignores an exit file beside a live holder for that id.
- `<session-id>.exit` (`0600`): `{"session_id", "code", "at"}`, written when the child exits while no daemon is connected; the next daemon records the code (`SetExit`) and deletes the file.
- `host.log` — holders' stderr, appended; empty in the normal course.
- Session ids must match `[A-Za-z0-9_-]{1,128}` to be used as a file name; any other id starts in-process.

**Wire protocol, version 1.** A frame is one type byte, a 4-byte big-endian payload length (≤ 8 MiB), the payload. The client's first frame is `H` and must arrive within 5s; a wrong token is answered `E` and closed. One client at a time: a new authenticated client replaces the previous one.

| Frame | Direction       | Payload                                                                  |
| ----- | --------------- | ------------------------------------------------------------------------ |
| `H`   | daemon → holder | `{"proto":1,"token":"…","resume":false,"since":N}`                       |
| `W`   | holder → daemon | `{"proto":1,"child_pid":N,"paused":false,"version":"…","offset":N,…}`    |
| `S`   | holder → daemon | the scrollback ring (256 KiB + mode prefix), once; skipped when `resume` |
| `O`   | holder → daemon | terminal bytes                                                           |
| `X`   | holder → daemon | `{"code":N}`, then the holder closes and exits                           |
| `E`   | holder → daemon | a refusal as text, then close                                            |
| `I`   | daemon → holder | typed bytes                                                              |
| `R`   | daemon → holder | `{"cols":N,"rows":N}`                                                    |
| `G`   | daemon → holder | `{"signal":"pause"\                                                      |
| `J`   | daemon → holder | client id length (1 byte), client id, 8-byte big-endian sequence, bytes  |
| `K`   | holder → daemon | `{"client":"…","req":N,"seq":N,"error":"…"}`, the answer to one `J`      |

**Terminal protocol v2 additions** (additive, still `proto` 1). `W` carries `offset` (one past the newest byte the holder has output), `ring_start` (offset of the oldest byte its ring holds; the `S` that follows is the mode prefix plus bytes `[ring_start, offset)`) and `seq_input: true`. A resuming `H` may carry `since`: the holder sends the bytes from there as one `O`, or an `S` when its ring no longer holds them. `J` types its bytes unless the sequence is at or below the last applied for that client (kept 120 s after the client was last heard from), and is always answered by a `K` with the client's last applied sequence (`req` echoes the `J`'s sequence; `J` with sequence 0 types nothing and only asks). A daemon facing a holder without `seq_input` writes `I` frames and deduplicates itself, and counts that holder's offsets from its own clock (see [Terminal socket, protocol v2](#terminal-socket-protocol-v2)); an older daemon never sends `since` or `J` and ignores the new `W` fields.

**Compatibility rule.** A holder started by one release must work with the daemon of the next. Frame types are never renumbered or repurposed; a side ignores a frame type it does not know. A change that cannot be made additively raises `proto`, and the daemon keeps speaking every older version while a holder of it can still be running. A registry entry with a newer `proto` than the daemon's is left alone (a downgrade).

**Lifecycle.** The daemon reattaches every registry entry at startup — after `OnExit` is wired, before the first liveness sweep and before the API serves. On shutdown it closes its connections and leaves holders running (`ptyman.ErrDetached` is not an exit and is not recorded as one). The session's pid in `sessions.pid` is the **child's**, so liveness ([ADR-028](08-decisions.md#adr-028--a-session-ends-when-its-process-does)) is unchanged. The holder ignores `SIGHUP` and `SIGINT`. On `SIGTERM` it sends its child's process group `SIGHUP` (what closing a terminal window sends: an interactive shell ignores `SIGTERM` but exits on a hangup and hangs up its jobs) and then `SIGTERM`, kills the group if the child is still running 750 ms later, and exits when the child does — within about a second. Windows is unchanged: there `SIGTERM` already ends the child. Pause, resume, kill and resize go through the holder.

**Orphans** (2026-10-10). A holder exits when its child does, and a daemon
reattaches whatever its registry lists — but a holder whose registry is gone
is reachable by nobody, and if its child is a login shell it never exits. The
owner's machine had fifteen of them, a day and a half old: a demo script ran
throwaway daemons with `CAPROCK_DATA_DIR` in `$TMPDIR`, opened shell tabs,
stopped the daemon, `pkill -f`'d processes whose command line named the
directory — a holder's command line is just `caprock pty-host`, so none was
matched — and deleted the directory. So each holder now carries
`CAPROCK_PTYHOST_REGISTRY=<registry dir>` in its own environment (never its
child's, whose environment is the spec's), and the daemon judges every
`caprock pty-host` of its user (`ptyhost.Classify`):

- **`registered`** — listed in this daemon's registry. Never touched.
- **`young`** — under two minutes old: a holder starting up has, for a moment,
  neither child nor entry. Never touched.
- **`dead`** — no child process. Reaped, whichever Caprock started it.
- **`foreign`** — another data directory that still lists it, or a holder
  whose registry cannot be told (no `CAPROCK_PTYHOST_REGISTRY` and no
  `CAPROCK_DATA_DIR` in its environment — a daemon started with `--data-dir`
  leaves no trace, and the directory is never guessed from `HOME`, because a
  guessed directory that exists without the holder in it would make a running
  session look unreachable). Never touched.
- **`unreachable-idle`** — its registry directory is gone, or no longer lists
  it, and its child is a shell (`zsh`, `bash`, `sh`, `fish`, `pwsh`, `cmd`, …)
  with nothing running under it. Reaped.
- **`unreachable-busy`** — unreachable, but the child is an agent, or a shell
  running a command. Reported, never touched: something is still running.

`ours` is set for a holder that registered in this daemon's own registry
directory; `abandoned` (2026-10-13) for one whose registry directory no
longer exists at all — the Caprock that started it was deleted (a preview
stand in `$TMPDIR`, a removed install), so no daemon anywhere can attach to
it. Neither decides a reap any more: the daemon's own sweep and the button
stop every `reap` verdict (§ Resources).

A reap re-reads the process table before every signal and acts only when the
pid still has the start time it was judged with; it sends `SIGTERM` (the holder
hangs its child up and stops it, § Lifecycle), and `SIGKILL` after 3 s, which closes the PTY and
hangs the shell up the way closing a terminal window does. Windows has no
`SIGTERM`, so the holder is terminated at once and its pseudoconsole closes
the shell.

## Transcript JSONL (observed shape)

Not a public contract — the parser is schema-versioned and degrades to hooks-only mode on unknown shapes ([12-risks.md RISK-02](12-risks.md#risks)). What `ingest` relies on, as observed in a real Claude Code 2.1.x transcript on 2026-08-18:

- One JSON object per line; `type` ∈ `user`, `assistant`, `system`, `attachment`, plus session-meta lines (`mode`, `permission-mode`, `ai-title`, `last-prompt`, `file-history-snapshot`, `bridge-session`). All are ignored except `ai-title` (`aiTitle`, `sessionId`), which since parser v3 is stored as `sessions.title` and never becomes an event.
- `user`/`assistant`/`system` lines carry `uuid`, `parentUuid`, `timestamp` (RFC 3339), `sessionId`, `cwd`, `version`, `gitBranch`, `isSidechain`.
- `assistant` lines: `message.model`, `message.id`, `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`; `message.content[]` blocks (`text`, `tool_use`, …).
- `system` lines with `subtype: "turn_duration"` carry `durationMs`.
- The transcript is written asynchronously and may lag the in-memory conversation (Claude Code documents this) — hence hooks are the real-time source and transcripts the accounting source.
- Files live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; `transcript_path` in hook payloads points at the exact file. Subagent transcripts live at `<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl` and carry the parent `sessionId` plus `agentId`, `isSidechain: true`.
- **One API response is written as several `assistant` lines** (thinking / text / tool_use blocks split across lines), each repeating the *same* `message.id`, `requestId` and `usage`. Verified 2026-08-18 across 16,210 such groups in local transcripts: usage never differs within a `message.id`. Ingest therefore counts usage once per `message.id` (dedupe key `msg:<id>`); summing per line would over-count cache tokens 2–3×.
- Lines with `message.model == "<synthetic>"` are Claude Code's own notices, not turns; ignored.
- **A fork copies its parent's turns.** `claude --resume <id> --fork-session` writes the parent's history since its last `compact_boundary` into the new file: the same `uuid`, `message.id` and `usage`, with `sessionId` rewritten to the fork's. Observed 2026-10-03 on a Caprock-started fork: 827 of the parent's assistant messages, all of them still in the parent's file. Ingest prices each message id once across sessions (see **A turn is paid once across sessions** under Hook shim).
- **The first messages a compaction preserves are copied with zeroed usage.** `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` are 0, but `cache_creation.ephemeral_1h_input_tokens` keeps the original figure. The 1h write is part of `cache_creation_input_tokens`, so ingest bounds it by that total; read raw, each such copy was priced at a 1h cache write that never happened. On 2026-10-03, 6 of 24,239 local lines carrying the breakdown had it above the total, every one of them zeroed this way.
- **A record is at most 16 MiB** (`Tailer.MaxLine`), counting the bytes before its newline. The longest line in 4.0 GB of local transcripts (702 files, 593,686 lines) was 2.1 MB on 2026-10-18. A longer record is never held whole. It is read in fragments of the 256 KiB reader buffer, so a read keeps at most the limit plus one buffer however long the record is, and once the record passes the limit its bytes are dropped as they are read. It is counted once in `lines_malformed` and logged once with its path and offset, and reading resumes after its newline. Until that newline is written, the tailer remembers how far into the record it has read (`skipTo`) and the next read continues from there. The persisted offset stays on the record's first byte, so after a restart the record is read from its start and skipped again. A file that shrinks below the point already read counts as truncated and is read from the start. Records up to the limit are read as before. Until 2026-10-18 a complete record of any length went to the parser, after a read that allocated twice its size. Only an unfinished record over the limit was dropped, by moving the offset into its middle. The next read took that for a rewritten file and read the whole transcript again.

Golden fixtures for the parser (normal, compacted, malformed line, unknown schema field) live in `testdata/transcripts/`.

**A new copy from a branch** (`worktree_base`, `worktree_pull` on `POST /v1/agents`; `GET /v1/projects/{id}/branches`). `worktree` alone makes `caprock/<name>` from HEAD, as before. With `worktree_base` the branch starts from that branch instead; with `worktree_pull` the remote that has it (origin preferred) is fetched first and the copy starts from `<remote>/<base>`, so it is what the server has now. The new branch is created `--no-track`: a push never lands on the base. A base starting with `-` or holding a space or a ref metacharacter is refused before git runs. The branch list puts the remote's default branch (`origin/HEAD`, else main or master) first, then main, master, develop, dev, trunk, then the rest by newest commit; local and remote copies of one name are one row; Caprock's own `caprock/*` branches are left out. A paired phone gets it only for projects under home, like every project route.

**A new copy from a pull request** (`worktree_pr` on `POST /v1/agents`; New agent → From GitHub). A positive number, with `worktree` and without `worktree_base` (otherwise `400`). Before the copy is made the daemon runs `git fetch --quiet --no-tags <remote> +refs/pull/<n>/head:refs/caprock/pull/<n>` in the project — `origin`, else the only remote; none is `400` — with the user's own git credentials and a 60 s limit, as `worktree_pull` does, and makes `caprock/<worktree>` `--no-track` from that ref, then deletes the ref (the branch holds the commit). GitHub keeps `refs/pull/<n>/head` for every pull request, a fork's included, so no fork remote is added. A fetch that fails (no such pull request, no access) is `400` with git's words. The token is not used: this is git, not the API. With `attempts`, only the first copy fetches; the rest start from its commit (`worktree_pr` is dropped for them).
