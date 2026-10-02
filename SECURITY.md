# Security Policy

## Reporting a vulnerability

Please report privately via GitHub's **Report a vulnerability** button
(the repo's **Security** tab → **Advisories**). Do not open a public issue for
security bugs.

Caprock reads untrusted transcripts, writes to your Claude Code configuration
and can start processes, so reports are welcome. Include repro steps and your
OS + version.

## What leaves the machine

Nothing, unless you turn it on. Out of the box the daemon listens on
`127.0.0.1` only and makes no outbound calls. Each of the following is off
until you enable it, and each contacts exactly one host:

- **Release check** (`update_checks` in Settings) asks
  `api.github.com` for the latest release. It sends nothing about you.
- **Gemini questions** go to `generativelanguage.googleapis.com` with your own
  key, only when you send one. This one carries content: the text you typed.
  The key is the one you enter on the dashboard, or `GEMINI_API_KEY` in the
  environment, which takes precedence ([ADR-025](.ai/08-decisions.md)).
- **The weekly report** sends a message to `api.telegram.org` through a bot you
  created. It carries figures you already see on the dashboard — never a
  prompt, a reply, tool output or a file path. With no bot token configured
  there is no timer at all ([ADR-024](.ai/08-decisions.md)).
- **LAN access** (`caprock up --lan`, or the switch in the dashboard) opens a
  second listener on one private address of this machine, never `0.0.0.0`.
  See [Other devices](#other-devices).

The licence key is checked offline; activating it calls nothing
([ADR-022](.ai/08-decisions.md)).

## What Caprock stores, and where

**Your prompts and the agents' responses are stored in cleartext** in the local
SQLite database at `<data_dir>/caprock.db`. That is what the product is: the
Memory screen searches the prose across every session, which is only possible
because the text is on disk in readable form. Nothing is encrypted and nothing
is redacted.

The practical consequence: **anything that appears in a prompt, a tool result,
or a response is written to that file** — including secrets that happen to pass
through a session, such as an API key echoed by a command or pasted into a
prompt. Caprock does not scan for or strip credentials. Treat the database as
being as sensitive as the sessions it recorded.

The rest of `<data_dir>`:

- `config.json` — settings, plus the licence key, the Gemini key and the
  weekly-report bot token when you set them. They are write-only over the API: never returned to
  the dashboard and never written into an error.
- `runtime.json` — the port and a random per-run token that local clients use
  to authenticate.
- `devices.json` — paired devices and their tokens.
- `trust-grants.json` — the folders Caprock marked as trusted, so they can be
  revoked (see below).
- `paste/` — images and files you paste or drop into a terminal on the
  dashboard.
- `chats/` — working folders for quick chats, sessions started to ask something rather than to work on a repository.
- the log.

Where `<data_dir>` is per OS is documented in
[`.ai/08-decisions.md` § ADR-013](.ai/08-decisions.md).

### File permissions

On macOS and Linux, Caprock restricts the files it owns to the current user:

- the data directory itself is `0700`
- `config.json`, `runtime.json`, `devices.json` and the log are `0600`
- `caprock.db` and its `-wal` / `-shm` siblings are `0600`, applied on every
  daemon start — so a database created by an older version, which inherited the
  process umask (typically `0644`, world-readable), is tightened the next time
  the daemon opens it

On Windows there are no POSIX mode bits; access is governed by the ACL the files
inherit from the per-user data directory.

If Caprock cannot set these modes — a network share or a container volume that
does not support them — it logs a warning and keeps running rather than
refusing to start.

### Deleting your history

The database is a single file. Stop the daemon (`caprock down`) and delete
`caprock.db` along with its `-wal` and `-shm` siblings; Caprock recreates an
empty one on the next start.

## What Caprock changes outside its data directory

Everything here is reversible, and Caprock records what it did so it can undo
exactly that ([ADR-020](.ai/08-decisions.md)):

- **`~/.claude/settings.json`** — the hook entries for the shim and, if you
  install it, the status line. Your other hooks are untouched. A backup is kept
  before each change; `caprock hooks uninstall` removes Caprock's entries and
  `caprock hooks restore` puts a backup back.
- **`~/.claude.json`** — when Caprock starts a session in a folder, it marks
  that folder as trusted so Claude Code does not stop at the trust prompt. The
  file is edited in place, preserving order and everything else in it.
  `caprock hooks uninstall` revokes the grants Caprock made and never one you
  made yourself.

The shim never breaks a session: on any error it exits silently within a
second.

## What Caprock puts into a session

- **The handoff.** When a new Claude Code session starts in a repository,
  Caprock answers its `SessionStart` hook with the last substantial passage an
  agent wrote in that repository in the past 14 days, at most 1,200
  characters. That text comes from your own transcripts, so it is as
  trustworthy as they are — a session that read hostile content could carry it
  into the next one.
- **Typing.** The dashboard types only into sessions Caprock started. A session
  you started in your own terminal is never written into; continuing it starts
  a second process on the same history (`claude --resume`).
- **Orchestrated workers** run unattended with
  `--dangerously-skip-permissions`, inside their own git worktree, and stop at a
  budget — $5 when the task names none. Files a worker writes are treated as
  untrusted input: ids are validated before they become paths, and a worker's
  branch is never force-reset over your commits.

## The local API

The daemon serves its REST API and dashboard on `127.0.0.1` with no login,
because reaching it requires being on the machine. That boundary does **not**
hold against a web browser: any page you visit while the daemon runs can send
requests to `127.0.0.1`, and the same-origin policy stops the page reading the
response — it does not stop the request being sent, or stop what the request
does.

Since several endpoints are genuinely dangerous (`POST /v1/agents` starts a
process, `/v1/agents/{id}/input` types into a live session, `POST /v1/paste`
writes a file), every request to `/v1` must show it came from the dashboard or
from a local client: cross-site fetches are refused on every method, the `Host`
must name this machine, and a state-changing request needs a JSON body or the
per-run token. A missing `Origin` header is **not** treated as trusted. The
layers are described in
[`.ai/03-contracts.md` § Cross-site request protection](.ai/03-contracts.md).

## Other devices

With LAN access on, a phone or tablet on the same network gets in only by
pairing: a six-digit code shown on this machine, single-use, valid five minutes
and burned after five wrong guesses. Everything except pairing itself requires
the device token, sent as a header and never in a URL.

A paired device is a reader, not a second owner. It may make only the reads on
an explicit allowlist; starting, typing into or stopping a session, changing
settings, the licence and pairing more devices are all refused. Revoking a
device takes effect on its next request. The decision to listen is not saved:
a restarted daemon is back on loopback only. Details:
[`.ai/03-contracts.md` § Who may connect](.ai/03-contracts.md) and
[ADR-029](.ai/08-decisions.md).

## Supported versions

The latest release.
